-- Migration 0012 gave a problem a free-text note. It never earned the column it
-- cost: the bank is a page for picking what to practise, and thirteen rems of
-- prose across every row bought nothing Mike read. The cell went unfilled.
--
-- Dropped rather than left unread -- a column nothing writes is a column the
-- next reader has to work out the status of.
ALTER TABLE math_practice_problem DROP COLUMN comment;
