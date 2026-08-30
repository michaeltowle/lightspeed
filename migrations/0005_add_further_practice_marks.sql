-- A mark is not a grade. Getting a problem wrong says what happened; marking
-- it says what to do next. They usually agree, which is why the answer page
-- ticks the box for you on a wrong, but either can be set without the other.
ALTER TABLE problem_attempt
  ADD COLUMN marked_for_further_practice INTEGER NOT NULL DEFAULT 0;

-- Where a set came from, when it was built by asking for further practice on
-- a previous one. NULL for a set composed from scratch.
ALTER TABLE problem_set
  ADD COLUMN preceding_problem_set_id INTEGER REFERENCES problem_set(id);
