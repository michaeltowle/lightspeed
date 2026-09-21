-- Four things an attempt did not record until now.
--
-- The credit an attempt earned, as a fraction kept in two pieces. 'partial' said
-- only that some maneuvers were got and some were not, which is the same word
-- for one out of six and five out of six. These two counts say which, and they
-- are stored rather than recomputed from the marks: a problem re-broken later
-- gets a new maneuver table, and a denominator recomputed against it would
-- quietly restate work already graded. Kept unreduced -- 3/6 is three of six
-- steps, not one half of anything, and halving it would throw away the six.
--
-- NULL on an attempt that was never graded, which is what the marks already say.
ALTER TABLE problem_attempt ADD COLUMN count_of_maneuvers_got    INTEGER;
ALTER TABLE problem_attempt ADD COLUMN count_of_maneuvers_faced  INTEGER;

-- How fast the work felt, said by Mike before moving on. Beside elapsed_ms and
-- not instead of it: the clock knows how long it took, and that is a different
-- fact from whether it felt laboured. A problem can be slow and correct.
--
-- NULL until said, and it is never compulsory -- next is not gated on it.
ALTER TABLE problem_attempt ADD COLUMN self_reported_working_speed TEXT
  CHECK (self_reported_working_speed IN ('slow', 'mid', 'fast'));

-- Why it went wrong, in Mike's own words, written at the answers page once the
-- maneuver marks have shown him where it went. Prose rather than a picklist: the
-- useful version of this is "dropped the minus when squaring", and no list of
-- reasons chosen up front would have had that in it.
ALTER TABLE problem_attempt ADD COLUMN why_this_one_went_wrong TEXT NOT NULL DEFAULT '';
