-- One generation run against an authored prompt. Replaying a prompt produces a
-- new set rather than mutating the old one, so past work stays intact.
CREATE TABLE tmpname_problem_set_01 (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  authored_math_prompt_id INTEGER NOT NULL
                            REFERENCES authored_math_prompt(id) ON DELETE CASCADE,
  requested_count         INTEGER NOT NULL,
  created_at              TEXT    NOT NULL
                            DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- problem_html and answer_html are model-emitted HTML with LaTeX in $...$
-- delimiters; KaTeX renders them client-side after insertion.
CREATE TABLE tmpname_problem_01 (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tmpname_problem_set_id INTEGER NOT NULL
                          REFERENCES tmpname_problem_set_01(id) ON DELETE CASCADE,
  ordinal               INTEGER NOT NULL,
  problem_html          TEXT    NOT NULL,
  answer_html           TEXT    NOT NULL
);

-- One forward-only pass through a set. A set can be worked more than once.
CREATE TABLE tmpname_practice_run_01 (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  tmpname_problem_set_id INTEGER NOT NULL
                           REFERENCES tmpname_problem_set_01(id) ON DELETE CASCADE,
  created_at             TEXT    NOT NULL
                           DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at           TEXT
);

-- One row per problem attempted -- this is the trophy unit. self_grade stays
-- NULL until the answer page, since grading happens after the whole run.
CREATE TABLE tmpname_attempt_01 (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  tmpname_problem_id       INTEGER NOT NULL
                             REFERENCES tmpname_problem_01(id) ON DELETE CASCADE,
  tmpname_practice_run_id  INTEGER NOT NULL
                             REFERENCES tmpname_practice_run_01(id) ON DELETE CASCADE,
  elapsed_ms               INTEGER NOT NULL,
  self_grade               TEXT
                             CHECK (self_grade IN ('right', 'wrong', 'skipped')),
  created_at               TEXT    NOT NULL
                             DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_tmpname_problem_01_set
  ON tmpname_problem_01 (tmpname_problem_set_id, ordinal);

CREATE INDEX idx_tmpname_practice_run_01_set
  ON tmpname_practice_run_01 (tmpname_problem_set_id);

CREATE INDEX idx_tmpname_attempt_01_run
  ON tmpname_attempt_01 (tmpname_practice_run_id);

-- The trophy wall reads every attempt ever, oldest first.
CREATE INDEX idx_tmpname_attempt_01_created_at
  ON tmpname_attempt_01 (created_at);
