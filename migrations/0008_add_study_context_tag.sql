-- A study context is where a practice type sits in the study. A type belongs to
-- as many as apply at once, which is why membership is a table of its own and
-- not a column on the generator.

-- COLLATE NOCASE on the unique name is what stops two spellings that differ
-- only in case becoming two tags that look identical and filter apart.
CREATE TABLE study_context_tag (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT    NOT NULL
               DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per generator that belongs to one study context.
CREATE TABLE study_context_tag_membership (
  named_problem_generator_id INTEGER NOT NULL
                               REFERENCES named_problem_generator(id) ON DELETE CASCADE,
  study_context_tag_id       INTEGER NOT NULL
                               REFERENCES study_context_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (named_problem_generator_id, study_context_tag_id)
);

-- The dashboard reads every membership at once, but filtering to one context
-- reads that context's, and that is the direction the primary key cannot serve.
CREATE INDEX idx_study_context_tag_membership_tag
  ON study_context_tag_membership (study_context_tag_id);
