-- Repair. `professorial_style_mandate` has been pointing at a table that has
-- not existed since 0011, and every insert into it has been failing with
-- "no such table: main.study_context_tag_pre_assignment" -- which is why the
-- table is still empty, and why nothing noticed for five migrations.
--
-- 0011 renamed `study_context_tag` out of the way to widen its CHECK. SQLite
-- follows a rename into other tables' foreign keys, so this one was quietly
-- re-pointed at `study_context_tag_pre_assignment`, and 0011 then dropped that
-- table. 0011 saw the hazard coming for `study_context_tag_membership` and
-- rebuilt it for exactly this reason; it simply did not know a second table
-- also held a reference.
--
-- The table is empty, so the rebuild carries nothing across. The index belongs
-- to the table and goes and comes back with it.
DROP TABLE professorial_style_mandate;

CREATE TABLE professorial_style_mandate (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_text            TEXT    NOT NULL,
  study_context_tag_id INTEGER REFERENCES study_context_tag(id) ON DELETE CASCADE,
  created_at           TEXT    NOT NULL
                         DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at          TEXT
);

CREATE INDEX idx_professorial_style_mandate_tag
  ON professorial_style_mandate (study_context_tag_id);
