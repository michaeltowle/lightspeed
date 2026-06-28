"""SQLite data layer for Lightspeed.

Owns the schema and all DB access. Pure stdlib (sqlite3) — NO sympy/LLM import,
so the server can depend on it without pulling generation machinery in at
runtime. The database file lives next to this module as lightspeed.db.

Problem lifecycle:  staged -> approved | rejected
  - Generation (in a Claude Code session) inserts problems as 'staged'.
  - staged.html surfaces staged problems for review.
  - Approving flips status to 'approved'  (approved == the bank).
  - Rejecting flips status to 'rejected'.

A problem is stored DECOMPOSED: a prose `instructions` line, up to three
`formula_*` (definitions/givens) and three `expression_*` (the operand) blocks,
and the `answer`. Each non-empty block renders independently (own copy button).

Types replace the old free-form tags: a `type` is a registered problem type
bound to its generator and canonical instruction (the guardrail). Applied at the
batch level (every problem in a batch gets the batch's type), stored M:N via
`problem_type`. We generate monotype batches, so in practice it is one type per
problem.
"""

import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lightspeed.db")

# The decomposed problem-statement fields, in order — also the dedup key.
PROBLEM_FIELDS = (
    "instructions",
    "formula_1", "formula_2", "formula_3",
    "expression_1", "expression_2", "expression_3",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS batch (
    id          INTEGER PRIMARY KEY,
    prompt      TEXT NOT NULL,          -- description that generated this set
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS problem (
    id                  INTEGER PRIMARY KEY,
    batch_id            INTEGER REFERENCES batch(id),
    instructions        TEXT NOT NULL,                 -- prose ask ("differentiate")
    formula_1           TEXT,                          -- definitions/givens (f(x)=…, X∼Dist)
    formula_2           TEXT,
    formula_3           TEXT,
    expression_1        TEXT,                          -- the operand (∫…dx, the function)
    expression_2        TEXT,
    expression_3        TEXT,
    answer              TEXT NOT NULL,                 -- raw TeX; sympy output
    answer_verified_by  TEXT,                          -- NULL unverified | 'sympy' confirmed
    problem_source      TEXT NOT NULL,
    answer_source       TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'staged', -- staged|approved|rejected
    gotcha              INTEGER NOT NULL DEFAULT 0,     -- instructive trap; weighted in drilling
    created_at          TEXT NOT NULL,
    approved_at         TEXT
);

CREATE TABLE IF NOT EXISTS type (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,          -- e.g. 'critical_points'
    generator           TEXT,                          -- generator fn in problem_types.py
    default_instruction TEXT                           -- canonical instruction (NULL for themes)
);

CREATE TABLE IF NOT EXISTS problem_type (
    problem_id INTEGER NOT NULL REFERENCES problem(id),
    type_id    INTEGER NOT NULL REFERENCES type(id),
    PRIMARY KEY (problem_id, type_id)
);

CREATE TABLE IF NOT EXISTS subtype (
    id        INTEGER PRIMARY KEY,
    type_id   INTEGER NOT NULL REFERENCES type(id),   -- subtypes are scoped to a type
    name      TEXT NOT NULL,                          -- e.g. 'integration_by_parts'
    UNIQUE (type_id, name)
);

CREATE TABLE IF NOT EXISTS problem_subtype (
    problem_id INTEGER NOT NULL REFERENCES problem(id),
    subtype_id INTEGER NOT NULL REFERENCES subtype(id),
    PRIMARY KEY (problem_id, subtype_id)
);

CREATE TABLE IF NOT EXISTS problem_set (
    id               INTEGER PRIMARY KEY,
    n_attempts       INTEGER NOT NULL DEFAULT 0,
    n_correct        INTEGER NOT NULL DEFAULT 0,
    finish_time      REAL,    -- total seconds across the set (set at finalize)
    time_per_problem REAL,    -- average seconds (set at finalize)
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempt (
    id                  INTEGER PRIMARY KEY,
    problem_set_id      INTEGER NOT NULL REFERENCES problem_set(id),
    problem_id          INTEGER NOT NULL REFERENCES problem(id),
    n_previous_attempts INTEGER NOT NULL DEFAULT 0,
    duration_seconds    REAL,            -- time spent on this problem (one-at-a-time)
    completed_at        TEXT NOT NULL,
    answered_correctly  INTEGER          -- 1 correct, 0 incorrect, NULL ungraded
);
"""


def now():
    return datetime.now(timezone.utc).isoformat()


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


# --- dedup ---------------------------------------------------------------

def problem_dedup_key(values):
    """Canonical dedup key from the PROBLEM_FIELDS values (None -> '').

    sympy serializes identical problems identically, so exact-match over the
    decomposed fields is a reliable duplicate test."""
    return "\x1f".join((v or "").strip() for v in values)


def existing_problem_keys(conn):
    """Map every problem's dedup key -> status, for dedup at generation time
    (across the whole bank regardless of status, so rejected never resurface)."""
    cols = ", ".join(PROBLEM_FIELDS)
    out = {}
    for r in conn.execute(f"SELECT {cols}, status FROM problem"):
        out[problem_dedup_key(r[f] for f in PROBLEM_FIELDS)] = r["status"]
    return out


# --- staging -------------------------------------------------------------

def create_batch(conn, prompt):
    cur = conn.execute(
        "INSERT INTO batch (prompt, created_at) VALUES (?, ?)", (prompt, now())
    )
    return cur.lastrowid


def insert_staged_problem(conn, batch_id, problem):
    """problem: dict with the PROBLEM_FIELDS plus answer, answer_verified_by
    (str|None), problem_source, answer_source, and optional gotcha (bool)."""
    cur = conn.execute(
        """INSERT INTO problem
           (batch_id, instructions, formula_1, formula_2, formula_3,
            expression_1, expression_2, expression_3, answer, answer_verified_by,
            problem_source, answer_source, gotcha, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)""",
        (
            batch_id,
            problem["instructions"],
            problem["formula_1"],
            problem["formula_2"],
            problem["formula_3"],
            problem["expression_1"],
            problem["expression_2"],
            problem["expression_3"],
            problem["answer"],
            problem["answer_verified_by"],
            problem["problem_source"],
            problem["answer_source"],
            1 if problem.get("gotcha") else 0,
            now(),
        ),
    )
    return cur.lastrowid


# --- reads ---------------------------------------------------------------

def staged_batches(conn):
    """All batches that still have at least one staged problem, with their
    staged problems nested. Newest batch first."""
    batches = conn.execute(
        """SELECT DISTINCT b.id, b.prompt, b.created_at
           FROM batch b JOIN problem p ON p.batch_id = b.id
           WHERE p.status = 'staged'
           ORDER BY b.id DESC"""
    ).fetchall()
    result = []
    for b in batches:
        problems = conn.execute(
            """SELECT * FROM problem
               WHERE batch_id = ? AND status = 'staged'
               ORDER BY id""",
            (b["id"],),
        ).fetchall()
        result.append(
            {
                "id": b["id"],
                "prompt": b["prompt"],
                "created_at": b["created_at"],
                "types": batch_types(conn, b["id"]),
                "subtypes": batch_subtypes(conn, b["id"]),
                "problems": [dict(p) for p in problems],
            }
        )
    return result


def batch_types(conn, batch_id):
    """Distinct types for a batch, with db_count = approved problems per type."""
    rows = conn.execute(
        """SELECT DISTINCT t.id, t.name, t.default_instruction,
                  (SELECT COUNT(*) FROM problem_type pt2
                   JOIN problem p2 ON p2.id = pt2.problem_id
                   WHERE pt2.type_id = t.id AND p2.status = 'approved') AS db_count
           FROM type t
           JOIN problem_type pt ON pt.type_id = t.id
           JOIN problem p ON p.id = pt.problem_id
           WHERE p.batch_id = ?
           ORDER BY t.name""",
        (batch_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def list_types(conn):
    rows = conn.execute(
        """SELECT t.id, t.name, t.default_instruction,
                  COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN p.id END)          AS problem_count,
                  COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN a.problem_id END)  AS attempted_count
           FROM type t
           LEFT JOIN problem_type pt ON pt.type_id = t.id
           LEFT JOIN problem p       ON p.id  = pt.problem_id
           LEFT JOIN attempt a       ON a.problem_id = p.id
           GROUP BY t.id, t.name, t.default_instruction
           ORDER BY t.name"""
    ).fetchall()
    return [dict(r) for r in rows]


def problems_by_type(conn, type_id):
    """Approved problems for a type, each enriched with attempt stats.

    Percentages are over *graded* attempts only (answered_correctly NOT NULL);
    None when a problem has no graded attempts. avg_seconds is the mean recorded
    per-problem time (None if never timed)."""
    rows = conn.execute(
        """SELECT p.*,
               (SELECT group_concat(s.name)
                  FROM problem_subtype ps JOIN subtype s ON s.id = ps.subtype_id
                  WHERE ps.problem_id = p.id) AS subtype_names,
               COUNT(a.id) AS total_attempts,
               COALESCE(SUM(CASE WHEN a.answered_correctly IS NOT NULL
                            THEN 1 ELSE 0 END), 0) AS graded_total,
               COALESCE(SUM(CASE WHEN a.answered_correctly = 1
                            THEN 1 ELSE 0 END), 0) AS correct_total,
               AVG(a.duration_seconds) AS avg_seconds
           FROM problem p
           JOIN problem_type pt ON pt.problem_id = p.id
           LEFT JOIN attempt a ON a.problem_id = p.id
           WHERE pt.type_id = ? AND p.status = 'approved'
           GROUP BY p.id
           ORDER BY p.id""",
        (type_id,),
    ).fetchall()

    out = []
    for r in rows:
        d = dict(r)
        graded, correct = d.pop("graded_total"), d.pop("correct_total")
        d["pct_total"] = round(100 * correct / graded) if graded else None
        if d.get("avg_seconds") is not None:
            d["avg_seconds"] = round(d["avg_seconds"], 1)
        names = d.pop("subtype_names")
        d["subtypes"] = names.split(",") if names else []
        out.append(d)
    return out


def problems_by_ids(conn, ids):
    if not ids:
        return []
    qs = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT * FROM problem WHERE id IN ({qs})", list(ids)
    ).fetchall()
    return [dict(r) for r in rows]


def prior_attempt_count(conn, problem_id):
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM attempt WHERE problem_id = ?", (problem_id,)
    ).fetchone()
    return row["c"]


# --- writes: types & approval -------------------------------------------

def get_or_create_type(conn, name, generator=None, default_instruction=None):
    """Upsert a registered type. When metadata is supplied (from the
    problem_types registry at staging time) it is refreshed, keeping the guardrail
    binding name -> generator -> default_instruction current."""
    name = name.strip()
    row = conn.execute("SELECT id FROM type WHERE name = ?", (name,)).fetchone()
    if row:
        if generator is not None:
            conn.execute(
                "UPDATE type SET generator = ?, default_instruction = ? WHERE id = ?",
                (generator, default_instruction, row["id"]),
            )
        return row["id"]
    cur = conn.execute(
        "INSERT INTO type (name, generator, default_instruction) VALUES (?, ?, ?)",
        (name, generator, default_instruction),
    )
    return cur.lastrowid


def apply_type_to_batch(conn, batch_id, type_id):
    """Types are batch-level: apply the type to every problem in the batch."""
    pids = [
        r["id"]
        for r in conn.execute(
            "SELECT id FROM problem WHERE batch_id = ?", (batch_id,)
        )
    ]
    for pid in pids:
        conn.execute(
            "INSERT OR IGNORE INTO problem_type (problem_id, type_id) VALUES (?, ?)",
            (pid, type_id),
        )


def get_or_create_subtype(conn, type_id, name):
    """Upsert a subtype scoped to a type (depth-1 label, e.g. method)."""
    name = name.strip()
    row = conn.execute(
        "SELECT id FROM subtype WHERE type_id = ? AND name = ?", (type_id, name)
    ).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO subtype (type_id, name) VALUES (?, ?)", (type_id, name)
    )
    return cur.lastrowid


def apply_subtype_to_batch(conn, batch_id, subtype_id):
    """Subtypes are batch-level: apply to every problem in the batch."""
    pids = [
        r["id"]
        for r in conn.execute(
            "SELECT id FROM problem WHERE batch_id = ?", (batch_id,)
        )
    ]
    for pid in pids:
        conn.execute(
            "INSERT OR IGNORE INTO problem_subtype (problem_id, subtype_id) VALUES (?, ?)",
            (pid, subtype_id),
        )


def subtypes_by_type(conn):
    """Map of type name -> sorted list of its existing subtype names. Surfaced so
    generation reuses existing subtypes instead of coining drift variants."""
    out = {}
    for r in conn.execute(
        """SELECT t.name AS type_name, s.name AS subtype_name
           FROM subtype s JOIN type t ON t.id = s.type_id
           ORDER BY t.name, s.name"""
    ):
        out.setdefault(r["type_name"], []).append(r["subtype_name"])
    return out


def batch_subtypes(conn, batch_id):
    """Distinct subtype names attached to a batch's problems."""
    rows = conn.execute(
        """SELECT DISTINCT s.name
           FROM subtype s
           JOIN problem_subtype ps ON ps.subtype_id = s.id
           JOIN problem p ON p.id = ps.problem_id
           WHERE p.batch_id = ?
           ORDER BY s.name""",
        (batch_id,),
    ).fetchall()
    return [r["name"] for r in rows]


def reject_problem(conn, problem_id):
    conn.execute(
        "UPDATE problem SET status = 'rejected' WHERE id = ?", (problem_id,)
    )


def approve_batch(conn, batch_id):
    """Approve every still-staged problem in a batch at once (rejected ones,
    already flipped per-problem, are left alone). Returns count approved."""
    cur = conn.execute(
        """UPDATE problem SET status = 'approved', approved_at = ?
           WHERE batch_id = ? AND status = 'staged'""",
        (now(), batch_id),
    )
    return cur.rowcount


def undo_approve_batch(conn, batch_id):
    """Revert all approved/rejected problems in a batch back to staged.
    Used for the in-session undo after approving a batch."""
    cur = conn.execute(
        """UPDATE problem SET status = 'staged', approved_at = NULL
           WHERE batch_id = ? AND status IN ('approved', 'rejected')""",
        (batch_id,),
    )
    return cur.rowcount


# --- writes: problem sets & attempts ------------------------------------

def create_problem_set(conn):
    cur = conn.execute(
        "INSERT INTO problem_set (created_at) VALUES (?)", (now(),)
    )
    return cur.lastrowid


def set_problem_set_timing(conn, problem_set_id, finish_time, time_per_problem):
    """Record total/per-problem time at finalize."""
    conn.execute(
        "UPDATE problem_set SET finish_time = ?, time_per_problem = ? WHERE id = ?",
        (finish_time, time_per_problem, problem_set_id),
    )


def record_attempt(conn, problem_set_id, problem_id, answered_correctly,
                   duration_seconds=None):
    """answered_correctly: True / False / None (ungraded). duration_seconds: the
    time spent on this problem (recorded when 'next' was clicked). Returns id."""
    n_prev = prior_attempt_count(conn, problem_id)
    correct = None if answered_correctly is None else (1 if answered_correctly else 0)
    cur = conn.execute(
        """INSERT INTO attempt
           (problem_set_id, problem_id, n_previous_attempts, duration_seconds,
            completed_at, answered_correctly)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (problem_set_id, problem_id, n_prev, duration_seconds, now(), correct),
    )
    return cur.lastrowid


def finalize_problem_set_counts(conn, problem_set_id):
    row = conn.execute(
        """SELECT COUNT(*) AS n,
                  SUM(CASE WHEN answered_correctly = 1 THEN 1 ELSE 0 END) AS c
           FROM attempt WHERE problem_set_id = ?""",
        (problem_set_id,),
    ).fetchone()
    conn.execute(
        "UPDATE problem_set SET n_attempts = ?, n_correct = ? WHERE id = ?",
        (row["n"], row["c"] or 0, problem_set_id),
    )


if __name__ == "__main__":
    init_db()
    print("Initialized", DB_PATH)
