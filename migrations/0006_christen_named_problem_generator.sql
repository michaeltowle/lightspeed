-- Mechanical rename. The prompt row was always the generator -- it just had no
-- name, was never reused, and was never shown. One row per generate made that
-- invisible; from here one row is a standing practice type that opens sets for
-- as long as it is useful.
--
-- No shape change: same columns, same constraints, same data. SQLite rewrites
-- index definitions and foreign-key clauses to follow a renamed table or
-- column, so only the index *names* need explicit work below.
ALTER TABLE authored_math_prompt RENAME TO named_problem_generator;

ALTER TABLE problem_set
  RENAME COLUMN authored_math_prompt_id TO named_problem_generator_id;
ALTER TABLE math_prompt_image_attachment
  RENAME COLUMN authored_math_prompt_id TO named_problem_generator_id;

DROP INDEX idx_authored_math_prompt_created_at;
DROP INDEX idx_math_prompt_image_attachment_prompt;

CREATE INDEX idx_named_problem_generator_created_at
  ON named_problem_generator (created_at DESC);
CREATE INDEX idx_math_prompt_image_attachment_generator
  ON math_prompt_image_attachment (named_problem_generator_id, ordinal);
