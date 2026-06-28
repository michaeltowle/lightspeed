"""SQLite data layer for Lightspeed.

Owns the schema and all DB access. Pure stdlib (sqlite3). The database file
lives next to this module as lightspeed.db.

Problem lifecycle:  staged -> approved | rejected
  - Generation (in a Claude Code session) inserts problems as 'staged'.
  - add-problems.html surfaces staged problems for review.
  - Approving flips status to 'approved'  (approved == the bank).
  - Rejecting flips status to 'rejected'.
"""

import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lightspeed.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS batch (
    id          INTEGER PRIMARY KEY,
    prompt      TEXT NOT NULL,          -- description that generated this set
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS problem (
    id                  INTEGER PRIMARY KEY,
    batch_id            INTEGER REFERENCES batch(id),
    latex_problem_text  TEXT NOT NULL,
    latex_answer_text   TEXT NOT NULL,
    answer_verified_by  TEXT,                          -- NULL unverified | 'sympy' confirmed
    problem_source      TEXT NOT NULL,
    answer_source       TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'staged', -- staged|approved|rejected
    starred             INTEGER NOT NULL DEFAULT 0,    -- user-marked "interesting"
    problematic         INTEGER NOT NULL DEFAULT 0,    -- user-flagged "something wrong"
    created_at          TEXT NOT NULL,
    approved_at         TEXT
);

CREATE TABLE IF NOT EXISTS tag (
    id           INTEGER PRIMARY KEY,
    display_text TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS problem_tag (
    problem_id INTEGER NOT NULL REFERENCES problem(id),
    tag_id     INTEGER NOT NULL REFERENCES tag(id),
    PRIMARY KEY (problem_id, tag_id)
);

CREATE TABLE IF NOT EXISTS problem_list (
    id               INTEGER PRIMARY KEY,
    is_timed         INTEGER NOT NULL,
    n_attempts       INTEGER NOT NULL DEFAULT 0,
    n_correct        INTEGER NOT NULL DEFAULT 0,
    finish_time      REAL,    -- seconds; NULL if untimed
    time_per_problem REAL,    -- seconds; NULL if untimed
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempt (
    id                  INTEGER PRIMARY KEY,
    problem_list_id     INTEGER NOT NULL REFERENCES problem_list(id),
    problem_id          INTEGER NOT NULL REFERENCES problem(id),
    n_previous_attempts INTEGER NOT NULL DEFAULT 0,
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
    """Idempotent column adds for DBs created before a schema change."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(problem)")}
    if "starred" not in cols:
        conn.execute(
            "ALTER TABLE problem ADD COLUMN starred INTEGER NOT NULL DEFAULT 0"
        )
    if "problematic" not in cols:
        conn.execute(
            "ALTER TABLE problem ADD COLUMN problematic INTEGER NOT NULL DEFAULT 0"
        )
    if "answer_is_verified" in cols:
        conn.execute("ALTER TABLE problem ADD COLUMN answer_verified_by TEXT")
        conn.execute(
            "UPDATE problem SET answer_verified_by = 'sympy' WHERE answer_is_verified = 1"
        )
        conn.execute("ALTER TABLE problem DROP COLUMN answer_is_verified")


# --- staging -------------------------------------------------------------

def create_batch(conn, prompt):
    cur = conn.execute(
        "INSERT INTO batch (prompt, created_at) VALUES (?, ?)", (prompt, now())
    )
    return cur.lastrowid


def insert_staged_problem(conn, batch_id, problem):
    """problem: dict with latex_problem_text, latex_answer_text,
    answer_verified_by (str|None), problem_source, answer_source."""
    cur = conn.execute(
        """INSERT INTO problem
           (batch_id, latex_problem_text, latex_answer_text, answer_verified_by,
            problem_source, answer_source, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'staged', ?)""",
        (
            batch_id,
            problem["latex_problem_text"],
            problem["latex_answer_text"],
            problem["answer_verified_by"],
            problem["problem_source"],
            problem["answer_source"],
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
                "tags": batch_tags(conn, b["id"]),
                "problems": [dict(p) for p in problems],
            }
        )
    return result


def batch_tags(conn, batch_id):
    """Distinct tags for a batch, with db_count = approved problems per tag."""
    rows = conn.execute(
        """SELECT DISTINCT t.id, t.display_text,
                  (SELECT COUNT(*) FROM problem_tag pt2
                   JOIN problem p2 ON p2.id = pt2.problem_id
                   WHERE pt2.tag_id = t.id AND p2.status = 'approved') AS db_count
           FROM tag t
           JOIN problem_tag pt ON pt.tag_id = t.id
           JOIN problem p ON p.id = pt.problem_id
           WHERE p.batch_id = ?
           ORDER BY t.display_text""",
        (batch_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def list_tags(conn):
    rows = conn.execute(
        """SELECT t.id, t.display_text,
                  COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN p.id END)          AS problem_count,
                  COUNT(DISTINCT CASE WHEN p.status = 'approved' THEN a.problem_id END)  AS attempted_count
           FROM tag t
           LEFT JOIN problem_tag pt ON pt.tag_id = t.id
           LEFT JOIN problem p      ON p.id  = pt.problem_id
           LEFT JOIN attempt a      ON a.problem_id = p.id
           GROUP BY t.id, t.display_text
           ORDER BY t.display_text"""
    ).fetchall()
    return [dict(r) for r in rows]


def problems_by_tag(conn, tag_id):
    """Approved problems for a tag, each enriched with attempt stats.

    Stats split quiz (timed problem_list) vs practice (untimed). Percentages
    are over *graded* attempts only (answered_correctly NOT NULL); they are
    None when a problem has no graded attempts in that bucket.
    """
    rows = conn.execute(
        """SELECT p.*,
               COUNT(a.id) AS total_attempts,
               COALESCE(SUM(pl.is_timed), 0) AS quiz_attempts,
               COALESCE(SUM(CASE WHEN pl.is_timed = 0 THEN 1 ELSE 0 END), 0)
                   AS practice_attempts,
               COALESCE(SUM(CASE WHEN a.answered_correctly IS NOT NULL
                            THEN 1 ELSE 0 END), 0) AS graded_total,
               COALESCE(SUM(CASE WHEN a.answered_correctly = 1
                            THEN 1 ELSE 0 END), 0) AS correct_total,
               COALESCE(SUM(CASE WHEN pl.is_timed = 1
                            AND a.answered_correctly IS NOT NULL
                            THEN 1 ELSE 0 END), 0) AS graded_quiz,
               COALESCE(SUM(CASE WHEN pl.is_timed = 1
                            AND a.answered_correctly = 1
                            THEN 1 ELSE 0 END), 0) AS correct_quiz,
               COALESCE(SUM(CASE WHEN pl.is_timed = 0
                            AND a.answered_correctly IS NOT NULL
                            THEN 1 ELSE 0 END), 0) AS graded_practice,
               COALESCE(SUM(CASE WHEN pl.is_timed = 0
                            AND a.answered_correctly = 1
                            THEN 1 ELSE 0 END), 0) AS correct_practice
           FROM problem p
           JOIN problem_tag pt ON pt.problem_id = p.id
           LEFT JOIN attempt a ON a.problem_id = p.id
           LEFT JOIN problem_list pl ON pl.id = a.problem_list_id
           WHERE pt.tag_id = ? AND p.status = 'approved'
           GROUP BY p.id
           ORDER BY p.id""",
        (tag_id,),
    ).fetchall()

    def pct(correct, graded):
        return round(100 * correct / graded) if graded else None

    out = []
    for r in rows:
        d = dict(r)
        d["pct_total"] = pct(d.pop("correct_total"), d.pop("graded_total"))
        d["pct_quiz"] = pct(d.pop("correct_quiz"), d.pop("graded_quiz"))
        d["pct_practice"] = pct(
            d.pop("correct_practice"), d.pop("graded_practice")
        )
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


def existing_problem_texts(conn):
    """Map of every problem's latex_problem_text -> status, for dedup at
    generation time (sympy serializes identical problems identically)."""
    return {
        r["latex_problem_text"]: r["status"]
        for r in conn.execute("SELECT latex_problem_text, status FROM problem")
    }


def prior_attempt_count(conn, problem_id):
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM attempt WHERE problem_id = ?", (problem_id,)
    ).fetchone()
    return row["c"]


# --- writes: tags & approval --------------------------------------------

def get_or_create_tag(conn, display_text):
    display_text = display_text.strip()
    row = conn.execute(
        "SELECT id FROM tag WHERE display_text = ?", (display_text,)
    ).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO tag (display_text) VALUES (?)", (display_text,)
    )
    return cur.lastrowid


def apply_tags_to_batch(conn, batch_id, tag_ids):
    """Tags are batch-level: apply each tag to every problem in the batch."""
    pids = [
        r["id"]
        for r in conn.execute(
            "SELECT id FROM problem WHERE batch_id = ?", (batch_id,)
        )
    ]
    for pid in pids:
        for tid in tag_ids:
            conn.execute(
                "INSERT OR IGNORE INTO problem_tag (problem_id, tag_id) VALUES (?, ?)",
                (pid, tid),
            )


def delete_orphaned_tags(conn):
    """Delete tags no longer attached to any LIVE (staged or approved) problem.

    Rejecting a batch leaves its problem_tag rows pointing at now-rejected
    problems; if no other staged/approved problem shares the tag, the tag is
    orphaned. We remove the dangling problem_tag rows and the tag itself. A tag
    still used by any live problem (e.g. another staged batch) is kept — the
    check spans the whole DB, not one batch. Safe because rejected problems are
    never displayed and dedup keys on problem text, not tags. Returns the list
    of deleted display_texts. Run as garbage collection when tags are surfaced
    (see server's /api/staged and /api/tags), which keeps it clear of the
    reject-all undo: by the time a page reloads, the rejection is settled.
    """
    orphans = conn.execute(
        """SELECT id, display_text FROM tag
           WHERE id NOT IN (
               SELECT pt.tag_id FROM problem_tag pt
               JOIN problem p ON p.id = pt.problem_id
               WHERE p.status IN ('staged', 'approved'))"""
    ).fetchall()
    for r in orphans:
        conn.execute("DELETE FROM problem_tag WHERE tag_id = ?", (r["id"],))
        conn.execute("DELETE FROM tag WHERE id = ?", (r["id"],))
    return [r["display_text"] for r in orphans]


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


def set_problem_starred(conn, problem_id, starred):
    conn.execute(
        "UPDATE problem SET starred = ? WHERE id = ?",
        (1 if starred else 0, problem_id),
    )


def set_problem_problematic(conn, problem_id, problematic):
    conn.execute(
        "UPDATE problem SET problematic = ? WHERE id = ?",
        (1 if problematic else 0, problem_id),
    )


# --- writes: problem lists & attempts -----------------------------------

def create_problem_list(conn, is_timed, finish_time=None, time_per_problem=None):
    cur = conn.execute(
        """INSERT INTO problem_list
           (is_timed, finish_time, time_per_problem, created_at)
           VALUES (?, ?, ?, ?)""",
        (1 if is_timed else 0, finish_time, time_per_problem, now()),
    )
    return cur.lastrowid


def set_problem_list_timing(conn, problem_list_id, finish_time, time_per_problem):
    """Record total/per-problem time at finalize (timed quizzes only)."""
    conn.execute(
        "UPDATE problem_list SET finish_time = ?, time_per_problem = ? WHERE id = ?",
        (finish_time, time_per_problem, problem_list_id),
    )


def record_attempt(conn, problem_list_id, problem_id, answered_correctly):
    """answered_correctly: True / False / None (ungraded). Returns attempt id."""
    n_prev = prior_attempt_count(conn, problem_id)
    correct = None if answered_correctly is None else (1 if answered_correctly else 0)
    cur = conn.execute(
        """INSERT INTO attempt
           (problem_list_id, problem_id, n_previous_attempts, completed_at,
            answered_correctly)
           VALUES (?, ?, ?, ?, ?)""",
        (problem_list_id, problem_id, n_prev, now(), correct),
    )
    return cur.lastrowid


def finalize_problem_list_counts(conn, problem_list_id):
    row = conn.execute(
        """SELECT COUNT(*) AS n,
                  SUM(CASE WHEN answered_correctly = 1 THEN 1 ELSE 0 END) AS c
           FROM attempt WHERE problem_list_id = ?""",
        (problem_list_id,),
    ).fetchone()
    conn.execute(
        "UPDATE problem_list SET n_attempts = ?, n_correct = ? WHERE id = ?",
        (row["n"], row["c"] or 0, problem_list_id),
    )


if __name__ == "__main__":
    init_db()
    print("Initialized", DB_PATH)
