-- Mechanical rename of the deferred `tmpname_*` names from the MVP problem
-- flow. No shape change: same columns, same constraints, same data.
--
-- SQLite rewrites index definitions and foreign-key clauses to follow a renamed
-- table or column, so only the index *names* need explicit work below.
ALTER TABLE tmpname_problem_set_01  RENAME TO problem_set;
ALTER TABLE tmpname_problem_01      RENAME TO math_practice_problem;
ALTER TABLE tmpname_practice_run_01 RENAME TO practice_run;
ALTER TABLE tmpname_attempt_01      RENAME TO problem_attempt;

ALTER TABLE math_practice_problem RENAME COLUMN tmpname_problem_set_id  TO problem_set_id;
ALTER TABLE practice_run          RENAME COLUMN tmpname_problem_set_id  TO problem_set_id;
ALTER TABLE problem_attempt       RENAME COLUMN tmpname_problem_id      TO math_practice_problem_id;
ALTER TABLE problem_attempt       RENAME COLUMN tmpname_practice_run_id TO practice_run_id;

DROP INDEX idx_tmpname_problem_01_set;
DROP INDEX idx_tmpname_practice_run_01_set;
DROP INDEX idx_tmpname_attempt_01_run;
DROP INDEX idx_tmpname_attempt_01_created_at;

CREATE INDEX idx_math_practice_problem_set ON math_practice_problem (problem_set_id, ordinal);
CREATE INDEX idx_practice_run_set          ON practice_run (problem_set_id);
CREATE INDEX idx_problem_attempt_run       ON problem_attempt (practice_run_id);
CREATE INDEX idx_problem_attempt_created_at ON problem_attempt (created_at);
