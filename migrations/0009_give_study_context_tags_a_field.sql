-- A study context tag now belongs to a field: class, source, target or status.
-- One table rather than four, so a fifth field is a row and not a migration.
--
-- Uniqueness moves from the name alone to the name within its field, and a tag
-- gains the palette entry it wears. SQLite can do neither in place, so the pair
-- is rebuilt beside the old one and the rows are carried across -- ids and all,
-- since the membership rows point at them.
--
-- Tags written before this migration were filed under no field, because there
-- were none. They carry over as targets, which is what all of them name. Any
-- that belong elsewhere can be re-filed from the dashboard.

ALTER TABLE study_context_tag            RENAME TO study_context_tag_pre_field;
ALTER TABLE study_context_tag_membership RENAME TO study_context_tag_membership_pre_field;

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

-- 6 is where the target field starts in the palette and 10 is its length, which
-- is what the worker uses when it creates a tag. Counting older ids rather than
-- using a window function keeps this to what every SQLite build can do.
INSERT INTO study_context_tag (id, field, name, chip_color_ordinal, created_at)
SELECT old.id,
       'target',
       old.name,
       (6 + (SELECT COUNT(*) FROM study_context_tag_pre_field earlier
              WHERE earlier.id < old.id)) % 10,
       old.created_at
  FROM study_context_tag_pre_field old;

CREATE TABLE study_context_tag_membership (
  named_problem_generator_id INTEGER NOT NULL
                               REFERENCES named_problem_generator(id) ON DELETE CASCADE,
  study_context_tag_id       INTEGER NOT NULL
                               REFERENCES study_context_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (named_problem_generator_id, study_context_tag_id)
);

INSERT INTO study_context_tag_membership
  (named_problem_generator_id, study_context_tag_id)
SELECT named_problem_generator_id, study_context_tag_id
  FROM study_context_tag_membership_pre_field;

-- Membership first: it is the side holding the reference.
DROP TABLE study_context_tag_membership_pre_field;
DROP TABLE study_context_tag_pre_field;

-- The dashboard reads every membership at once, but filtering to one context
-- reads that context's, and that is the direction the primary key cannot serve.
CREATE INDEX idx_study_context_tag_membership_tag
  ON study_context_tag_membership (study_context_tag_id);
