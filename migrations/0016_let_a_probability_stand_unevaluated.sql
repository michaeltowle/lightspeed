-- The first standing convention, and the table's first row.
--
-- A probability reduced to a decimal throws away the only part worth marking.
-- 3486784401/10^10 says nothing (9/10)^10 had not already said, and the long
-- division in between is arithmetic, not a maneuver -- it is where a break can
-- go quietly wrong with nothing on the page to catch it. The setup is the work.
--
-- Unscoped, so it reaches every problem. It only bites where there is a
-- probability to leave standing, so nothing outside the probability classes
-- notices it. Scoping it to a class later is a single UPDATE.
INSERT INTO professorial_style_mandate (rule_text, study_context_tag_id)
VALUES (
  'A probability does not need to be evaluated. A binomial coefficient, a '
  || 'factorial, a power, or any sum or product of them may stand exactly as '
  || 'it is set up: $\binom{10}{2}(1/10)^2(9/10)^8$ is a finished answer, and '
  || 'reducing it to a decimal is not a maneuver of its own. Do the arithmetic '
  || 'only where the problem itself asks for a number.',
  NULL
);
