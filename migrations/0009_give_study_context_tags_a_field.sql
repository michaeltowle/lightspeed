-- A study context tag now belongs to a field: class, source, target or status.
-- One table rather than four, so a fifth field is a row and not a migration.
--
-- Both tables are dropped and rebuilt rather than altered. Uniqueness moves from
-- the name alone to the name within its field, which SQLite cannot do in place,
-- and nothing is lost: neither table has ever held a row.

DROP TABLE study_context_tag_membership;
DROP TABLE study_context_tag;

CREATE TABLE study_context_tag (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  field              TEXT    NOT NULL
                       CHECK (field IN ('class', 'source', 'target', 'status')),
  name               TEXT    NOT NULL COLLATE NOCASE,
  -- Which palette entry the tag wears, fixed when it is created so a tag keeps
  -- its colour for life rather than shifting as neighbours come and go.
  chip_color_ordinal INTEGER NOT NULL,
  created_at         TEXT    NOT NULL
                       DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (field, name)
);

CREATE TABLE study_context_tag_membership (
  named_problem_generator_id INTEGER NOT NULL
                               REFERENCES named_problem_generator(id) ON DELETE CASCADE,
  study_context_tag_id       INTEGER NOT NULL
                               REFERENCES study_context_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (named_problem_generator_id, study_context_tag_id)
);

CREATE INDEX idx_study_context_tag_membership_tag
  ON study_context_tag_membership (study_context_tag_id);
