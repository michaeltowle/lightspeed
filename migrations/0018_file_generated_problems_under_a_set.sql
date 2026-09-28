-- Free generate now files each request under an assignment of its own,
-- "Generated Set N", so the generated tab groups by request the way a class tab
-- groups by homework. This files the problems generated before that.
--
-- There is no record of which request made which problem, so the prompt stands
-- in for it: problems minted from the same text are one set. Two requests with
-- the same prompt would fold into one, which nothing generated so far did.
-- Sets are numbered in the order their first problem was made.
--
-- Only problems wearing no assignment yet: anything already filed stays where
-- it was put.

WITH unfiled AS (
  SELECT p.id, p.text_that_minted_this_problem AS mint
    FROM math_practice_problem p
   WHERE p.how_this_problem_came_to_be = 'built_to_order_from_a_prompt'
     AND NOT EXISTS (
       SELECT 1 FROM study_context_tag_membership m
         JOIN study_context_tag t ON t.id = m.study_context_tag_id
        WHERE m.math_practice_problem_id = p.id AND t.field = 'assignment')
),
sets AS (
  SELECT mint, MIN(id) AS first_id FROM unfiled GROUP BY mint
),
numbered AS (
  SELECT mint,
         (SELECT COUNT(*) FROM sets earlier WHERE earlier.first_id <= s.first_id) AS n
    FROM sets s
)
-- 3 is where the assignment field starts in the palette and 10 its length, as
-- the worker does it. The colour is never shown -- assignment chips go plain --
-- but the column wants a value.
INSERT INTO study_context_tag (field, name, chip_color_ordinal)
SELECT 'assignment', 'Generated Set ' || n, (3 + n) % 10 FROM numbered;

-- The same sets again, now that their tags exist. Nothing is filed yet, so the
-- unfiled list reads the same as it did above.
WITH unfiled AS (
  SELECT p.id, p.text_that_minted_this_problem AS mint
    FROM math_practice_problem p
   WHERE p.how_this_problem_came_to_be = 'built_to_order_from_a_prompt'
     AND NOT EXISTS (
       SELECT 1 FROM study_context_tag_membership m
         JOIN study_context_tag t ON t.id = m.study_context_tag_id
        WHERE m.math_practice_problem_id = p.id AND t.field = 'assignment')
),
sets AS (
  SELECT mint, MIN(id) AS first_id FROM unfiled GROUP BY mint
),
numbered AS (
  SELECT mint,
         (SELECT COUNT(*) FROM sets earlier WHERE earlier.first_id <= s.first_id) AS n
    FROM sets s
)
INSERT INTO study_context_tag_membership (math_practice_problem_id, study_context_tag_id)
SELECT u.id, t.id
  FROM unfiled u
  JOIN numbered s ON s.mint = u.mint
  JOIN study_context_tag t
    ON t.field = 'assignment' AND t.name = 'Generated Set ' || s.n;
