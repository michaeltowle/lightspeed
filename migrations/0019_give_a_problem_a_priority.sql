-- A problem's priority, set from the run as it is worked. One of three, or
-- none: a problem nobody has ranked is unranked, not tertiary.
--
-- Purely additive: every existing problem starts unranked.

ALTER TABLE math_practice_problem
  ADD COLUMN priority TEXT CHECK (priority IN ('primary', 'secondary', 'tertiary'));
