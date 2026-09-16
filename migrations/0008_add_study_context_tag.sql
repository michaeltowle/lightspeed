-- A study context is the class a practice type belongs to: a course number, a
-- textbook, an exam. A type belongs to as many as apply -- 6801 and Casella and
-- Exam 1 all at once -- which is why membership is a table of its own and not a
-- column on the generator.

-- COLLATE NOCASE on the unique name is what stops "Casella" and "casella"
-- becoming two tags that look identical on the dashboard and filter apart.
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
