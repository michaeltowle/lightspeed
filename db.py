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

# Focus progression, low -> high. You must be accurate before fast: a fresh type
# starts at 'accuracy' and graduates to 'speed' once every problem's most-recent
# attempt is correct; 'speed' -> 'mastery' is a manual promotion (for now).
FOCI = ("accuracy", "speed", "mastery")

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
    difficulty          TEXT NOT NULL DEFAULT 'medium', -- easy|medium|hard (curated)
    has_e               INTEGER NOT NULL DEFAULT 0,     -- involves Euler's e / exp (auto)
    has_ln              INTEGER NOT NULL DEFAULT 0,     -- involves natural log (auto)
    has_trig            INTEGER NOT NULL DEFAULT 0,     -- involves sine/cosine (auto)
    created_at          TEXT NOT NULL,
    approved_at         TEXT
);

CREATE TABLE IF NOT EXISTS type (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,          -- e.g. 'critical_points'
    generator           TEXT,                          -- generator fn in problem_types.py
    default_instruction TEXT,                          -- canonical instruction (NULL for themes)
    status              TEXT NOT NULL DEFAULT 'active'  -- active | locked (locked = out of random sets)
);

-- A type's progress is tracked as a sequence of focus PERIODS. The current
-- focus is the single open period (end_at IS NULL); closing it and opening a
-- new one is a focus transition. Attempts on the type's problems after a
-- period's start_at (and before its end_at) belong to that period, which is how
-- "stats during the current focus" are scoped.
CREATE TABLE IF NOT EXISTS type_focus_period (
    id        INTEGER PRIMARY KEY,
    type_id   INTEGER NOT NULL REFERENCES type(id),
    focus     TEXT NOT NULL,                           -- accuracy | speed | mastery
    start_at  TEXT NOT NULL,
    end_at    TEXT                                     -- NULL = current/open period
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
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()


def _migrate(conn):
    """Idempotent, non-destructive migrations for DBs created before a column or
    table existed. SQLite has no ADD COLUMN IF NOT EXISTS, so introspect first."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(type)")}
    if "status" not in cols:
        conn.execute(
            "ALTER TABLE type ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"
        )
    # Every type must have exactly one open focus period; backfill 'accuracy' for
    # any type that has none (freshly seeded types, or a pre-focus database). For
    # a pre-focus DB, anchor the backfilled period at the type's earliest attempt
    # so existing history isn't orphaned out of the current period; else now().
    missing = conn.execute(
        """SELECT t.id,
                  (SELECT MIN(a.completed_at) FROM attempt a
                   JOIN problem_type pt ON pt.problem_id = a.problem_id
                   WHERE pt.type_id = t.id) AS first_attempt
           FROM type t
           WHERE NOT EXISTS (SELECT 1 FROM type_focus_period f
                             WHERE f.type_id = t.id AND f.end_at IS NULL)"""
    ).fetchall()
    for r in missing:
        _open_focus_period(conn, r["id"], "accuracy", at=r["first_attempt"] or now())


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
            problem_source, answer_source, gotcha, difficulty,
            has_e, has_ln, has_trig, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)""",
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
            problem.get("difficulty") or "medium",
            1 if problem.get("has_e") else 0,
            1 if problem.get("has_ln") else 0,
            1 if problem.get("has_trig") else 0,
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


def problem_squares(conn):
    """Per type, its approved problems as compact 'squares' — id, difficulty, and
    whether attempted — ORDERED by difficulty (easy→medium→hard) then problem id.
    Drives the per-type square grid on the bank browser (each square is one
    problem, colored by attempt status). Returns {type_id: [ {id, difficulty,
    attempted}, ... ]}."""
    rows = conn.execute(
        """SELECT pt.type_id AS type_id, p.id AS id, p.difficulty AS difficulty,
                  (SELECT COUNT(*) FROM attempt a WHERE a.problem_id = p.id) AS n_attempts
           FROM problem p
           JOIN problem_type pt ON pt.problem_id = p.id
           WHERE p.status = 'approved'
           ORDER BY pt.type_id,
                    CASE p.difficulty WHEN 'easy' THEN 0 WHEN 'medium' THEN 1
                                      WHEN 'hard' THEN 2 ELSE 3 END,
                    p.id"""
    ).fetchall()
    out = {}
    for r in rows:
        out.setdefault(r["type_id"], []).append(
            {"id": r["id"], "difficulty": r["difficulty"], "attempted": r["n_attempts"] > 0}
        )
    return out


def list_types(conn):
    """Every registered type with its subtype names, approved/attempted counts,
    current focus + lock status + current-period stats, and its problem 'squares'
    (id/difficulty/attempted, difficulty-then-id ordered) — everything the bank
    browser needs to render the cards and group by focus."""
    rows = conn.execute(
        """SELECT t.id, t.name, t.generator, t.default_instruction, t.status,
                  (SELECT group_concat(s.name, '|') FROM subtype s
                   WHERE s.type_id = t.id) AS subtype_names,
                  COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN p.id END)          AS problem_count,
                  COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN a.problem_id END)  AS attempted_count
           FROM type t
           LEFT JOIN problem_type pt ON pt.type_id = t.id
           LEFT JOIN problem p       ON p.id  = pt.problem_id
           LEFT JOIN attempt a       ON a.problem_id = p.id
           GROUP BY t.id, t.name, t.generator, t.default_instruction, t.status
           ORDER BY t.name"""
    ).fetchall()
    squares = problem_squares(conn)
    out = []
    for r in rows:
        d = dict(r)
        names = d.pop("subtype_names")
        d["subtypes"] = names.split("|") if names else []
        period = current_focus_period(conn, d["id"])
        d["focus"] = period["focus"] if period else "accuracy"
        d["focus_since"] = period["start_at"] if period else None
        n, mastered = type_mastery(conn, d["id"])
        d["n_problems"], d["mastered"] = n, mastered
        d.update(type_period_stats(conn, d["id"], d["focus_since"] or now()))
        d["squares"] = squares.get(d["id"], [])
        out.append(d)
    return out


def problems_by_type(conn, type_id):
    """Approved problems for a type, each enriched with attempt stats.

    Percentages are over *graded* attempts only (answered_correctly NOT NULL);
    None when a problem has no graded attempts. avg_seconds is the mean recorded
    per-problem time (None if never timed). last_correct is the MOST-RECENT
    attempt's grade (1 correct / 0 incorrect / None if never graded or never
    attempted) — used to filter "incorrect-only" sets."""
    rows = conn.execute(
        """SELECT p.*,
               (SELECT group_concat(s.name)
                  FROM problem_subtype ps JOIN subtype s ON s.id = ps.subtype_id
                  WHERE ps.problem_id = p.id) AS subtype_names,
               (SELECT a2.answered_correctly FROM attempt a2
                  WHERE a2.problem_id = p.id
                  ORDER BY a2.completed_at DESC, a2.id DESC LIMIT 1) AS last_correct,
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
    # a fresh type starts an open 'accuracy' focus period (accurate before fast)
    _open_focus_period(conn, cur.lastrowid, "accuracy")
    return cur.lastrowid


def seed_types(conn, rows):
    """Upsert the whole type registry so the catalog (/types) lists every type
    even before it has problems. `rows`: (name, generator, default_instruction)."""
    for name, generator, default_instruction in rows:
        get_or_create_type(conn, name, generator, default_instruction)


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


# --- focus & lock --------------------------------------------------------

def _open_focus_period(conn, type_id, focus, at=None):
    """Open a new focus period (end_at NULL). Caller ensures any prior open
    period for this type is already closed."""
    cur = conn.execute(
        "INSERT INTO type_focus_period (type_id, focus, start_at) VALUES (?, ?, ?)",
        (type_id, focus, at or now()),
    )
    return cur.lastrowid


def current_focus_period(conn, type_id):
    """The type's open focus period (end_at IS NULL), or None if it somehow has
    none (init_db backfills one for every type)."""
    row = conn.execute(
        """SELECT * FROM type_focus_period
           WHERE type_id = ? AND end_at IS NULL
           ORDER BY id DESC LIMIT 1""",
        (type_id,),
    ).fetchone()
    return dict(row) if row else None


def set_focus(conn, type_id, focus, at=None):
    """Transition a type to a new focus: close the open period and open a fresh
    one. No-op (returns False) if already at that focus."""
    if focus not in FOCI:
        raise ValueError(f"unknown focus {focus!r}; valid: {', '.join(FOCI)}")
    at = at or now()
    cur = current_focus_period(conn, type_id)
    if cur and cur["focus"] == focus:
        return False
    conn.execute(
        "UPDATE type_focus_period SET end_at = ? WHERE type_id = ? AND end_at IS NULL",
        (at, type_id),
    )
    _open_focus_period(conn, type_id, focus, at)
    return True


def change_focus(conn, type_id, direction):
    """Manually step a type's focus one notch 'up' or 'down' the FOCI ladder
    (clamped at the ends). Returns the new focus, or None if already clamped."""
    cur = current_focus_period(conn, type_id)
    i = FOCI.index(cur["focus"]) if cur else 0
    j = i + (1 if direction == "up" else -1)
    if j < 0 or j >= len(FOCI):
        return None
    set_focus(conn, type_id, FOCI[j])
    return FOCI[j]


def type_mastery(conn, type_id):
    """(n_problems, mastered) for a type: how many approved problems it has, and
    how many have their MOST-RECENT attempt correct. mastered == n_problems (and
    n_problems > 0) is the accuracy->speed graduation gate."""
    row = conn.execute(
        """SELECT COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN last_correct = 1 THEN 1 ELSE 0 END), 0) AS mastered
           FROM (
               SELECT (SELECT a.answered_correctly FROM attempt a
                       WHERE a.problem_id = p.id
                       ORDER BY a.completed_at DESC, a.id DESC LIMIT 1) AS last_correct
               FROM problem p
               JOIN problem_type pt ON pt.problem_id = p.id
               WHERE pt.type_id = ? AND p.status = 'approved'
           )""",
        (type_id,),
    ).fetchone()
    return row["n"], row["mastered"]


def type_period_stats(conn, type_id, since):
    """Attempt stats for a type scoped to the current focus period: attempts at
    or after `since`. pct over graded attempts only; avg over timed attempts."""
    row = conn.execute(
        """SELECT COUNT(a.id) AS attempts,
                  COALESCE(SUM(CASE WHEN a.answered_correctly IS NOT NULL
                               THEN 1 ELSE 0 END), 0) AS graded,
                  COALESCE(SUM(CASE WHEN a.answered_correctly = 1
                               THEN 1 ELSE 0 END), 0) AS correct,
                  AVG(a.duration_seconds) AS avg_seconds
           FROM attempt a
           JOIN problem_type pt ON pt.problem_id = a.problem_id
           JOIN problem p ON p.id = a.problem_id
           WHERE pt.type_id = ? AND p.status = 'approved' AND a.completed_at >= ?""",
        (type_id, since),
    ).fetchone()
    graded = row["graded"]
    return {
        "period_attempts": row["attempts"],
        "period_pct": round(100 * row["correct"] / graded) if graded else None,
        "period_avg_seconds": round(row["avg_seconds"], 1)
        if row["avg_seconds"] is not None else None,
    }


def maybe_graduate(conn, type_id):
    """Auto-graduate accuracy -> speed when every approved problem's most-recent
    attempt is correct. Up-only and accuracy-only: never auto-demotes, never
    skips speed. Returns True if it graduated."""
    cur = current_focus_period(conn, type_id)
    if not cur or cur["focus"] != "accuracy":
        return False
    n, mastered = type_mastery(conn, type_id)
    if n > 0 and mastered == n:
        set_focus(conn, type_id, "speed")
        return True
    return False


def set_type_status(conn, type_id, status):
    """Lock/unlock a type. Locked types are excluded from randomly generated
    sets and hidden (no focus shown) on the bank browser."""
    if status not in ("active", "locked"):
        raise ValueError(f"unknown status {status!r}")
    conn.execute("UPDATE type SET status = ? WHERE id = ?", (status, type_id))


def types_for_attempts(conn, problem_ids):
    """Distinct type ids covering a set of attempted problems (to re-check
    graduation only for the types actually touched)."""
    if not problem_ids:
        return []
    qs = ",".join("?" for _ in problem_ids)
    rows = conn.execute(
        f"SELECT DISTINCT type_id FROM problem_type WHERE problem_id IN ({qs})",
        list(problem_ids),
    ).fetchall()
    return [r["type_id"] for r in rows]


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
