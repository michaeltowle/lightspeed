-- A free-text note Mike leaves on a problem: what the professor wants, what
-- went wrong last time, which identity to reach for.
--
-- A column rather than a tag, because it is prose and belongs to one problem.
-- A tag is a name shared by many problems -- that is the whole point of the
-- membership table -- and a note that read the same on every problem wearing
-- it would be no note at all.
ALTER TABLE math_practice_problem ADD COLUMN comment TEXT NOT NULL DEFAULT '';
