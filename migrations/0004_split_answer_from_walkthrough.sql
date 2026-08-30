-- The answer page now shows the answer alone in a box you can check at a
-- glance, with the worked steps folded away beneath it. That needs the two
-- halves stored apart rather than as one blob of "worked answer" HTML.
--
-- Existing rows hold a worked answer, which is a walkthrough, not a bare
-- answer -- so it moves to solution_walkthrough_html and final_answer_html is
-- left empty. Old sets show no quick-check answer, which is honest: they never
-- had one. The trailing "Hence" line is likewise absent from them.
ALTER TABLE math_practice_problem
  ADD COLUMN final_answer_html TEXT NOT NULL DEFAULT '';
ALTER TABLE math_practice_problem
  ADD COLUMN solution_walkthrough_html TEXT NOT NULL DEFAULT '';

UPDATE math_practice_problem SET solution_walkthrough_html = answer_html;

ALTER TABLE math_practice_problem DROP COLUMN answer_html;
