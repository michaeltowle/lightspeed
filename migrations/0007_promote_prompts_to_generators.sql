-- Promote the renamed prompt rows into generators you can actually see and
-- re-enter: give them a name, a remembered set size, and an archive flag.
--
-- Every generate up to now wrote its own row, so the table is mostly duplicates
-- and one-offs. They are all backfilled as archived: the dashboard opens empty
-- and you promote what is worth keeping, rather than starting under a pile of
-- prompt fragments.
ALTER TABLE named_problem_generator ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE named_problem_generator ADD COLUMN archived_at TEXT;
ALTER TABLE named_problem_generator ADD COLUMN requested_count INTEGER NOT NULL DEFAULT 2;

-- What actually produced this set. A generator's prompt can be edited after the
-- fact, so without this a set worked last week would silently claim to have come
-- from text that did not exist yet. Migration 0001 promised replay fidelity and
-- has not delivered it for generated sets since 0002; this is where it lands.
ALTER TABLE problem_set ADD COLUMN prompt_text_as_generated TEXT NOT NULL DEFAULT '';

UPDATE problem_set SET prompt_text_as_generated = COALESCE((
  SELECT g.prompt_text FROM named_problem_generator g
   WHERE g.id = problem_set.named_problem_generator_id), '');

-- Fold prompts with identical text into one generator.
--
-- Only prompts with no attachments are folded. Two prompts that read the same
-- but carry different screenshots are different practice types, and merging
-- them would collide attachment ordinals besides.
CREATE TABLE tmp_generator_merge AS
SELECT g.id AS old_id,
       (SELECT MIN(g2.id) FROM named_problem_generator g2
         WHERE TRIM(g2.prompt_text) = TRIM(g.prompt_text)
           AND NOT EXISTS (SELECT 1 FROM math_prompt_image_attachment a
                            WHERE a.named_problem_generator_id = g2.id)
       ) AS keep_id
  FROM named_problem_generator g
 WHERE NOT EXISTS (SELECT 1 FROM math_prompt_image_attachment a
                    WHERE a.named_problem_generator_id = g.id);

-- Order is load-bearing. problem_set references the generator ON DELETE CASCADE,
-- so the re-point below MUST complete before any generator row is deleted --
-- otherwise the duplicates' sets, runs and attempts go with them.
UPDATE problem_set SET named_problem_generator_id =
  (SELECT keep_id FROM tmp_generator_merge WHERE old_id = named_problem_generator_id)
 WHERE named_problem_generator_id IN (SELECT old_id FROM tmp_generator_merge);

DELETE FROM named_problem_generator
 WHERE id IN (SELECT old_id FROM tmp_generator_merge WHERE old_id <> keep_id);

DROP TABLE tmp_generator_merge;

-- A first-line name is a placeholder, not a christening. Naming happens as you
-- promote each one out of the drawer, where the rename box can ask the model.
UPDATE named_problem_generator
   SET name = SUBSTR(TRIM(REPLACE(REPLACE(prompt_text, CHAR(13), ' '), CHAR(10), ' ')), 1, 48),
       archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE name = '';

CREATE INDEX idx_named_problem_generator_archived
  ON named_problem_generator (archived_at);
