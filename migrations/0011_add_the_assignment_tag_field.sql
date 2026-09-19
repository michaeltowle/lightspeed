-- A study context tag can now be filed under `assignment`: the piece of work it
-- was set as, "homework 4".
--
-- An assignment is deliberately not a parent. The problem stays the atom, as it
-- has since 0010; an assignment is only a label that every problem set together
-- wears. That is what lets a set be added at once, worked at once, and served
-- again as a group later, without anything owning the problems or having to be
-- asked where they came from.
--
-- SQLite cannot widen a CHECK in place, so the pair is rebuilt beside the old
-- one and the rows carried across, ids and all, exactly as 0009 did. Both
-- tables are rebuilt rather than just the one that changes: membership holds
-- the foreign key, and ALTER TABLE ... RENAME would re-point it at the table
-- being retired.

ALTER TABLE study_context_tag            RENAME TO study_context_tag_pre_assignment;
ALTER TABLE study_context_tag_membership RENAME TO study_context_tag_membership_pre_assignment;

CREATE TABLE study_context_tag (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  field              TEXT    NOT NULL
                       CHECK (field IN ('class', 'assignment', 'source',
                                        'target', 'status')),
  name               TEXT    NOT NULL COLLATE NOCASE,
  -- Which palette entry the tag wears, fixed when it is created so a tag keeps
  -- its colour for life rather than shifting as neighbours come and go.
  chip_color_ordinal INTEGER NOT NULL,
  created_at         TEXT    NOT NULL
                       DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (field, name)
);

-- Carried across unchanged: no tag predates the assignment field, so there is
-- nothing to re-file the way 0009 had to.
INSERT INTO study_context_tag (id, field, name, chip_color_ordinal, created_at)
SELECT id, field, name, chip_color_ordinal, created_at
  FROM study_context_tag_pre_assignment;

CREATE TABLE study_context_tag_membership (
  math_practice_problem_id INTEGER NOT NULL
                             REFERENCES math_practice_problem(id) ON DELETE CASCADE,
  study_context_tag_id     INTEGER NOT NULL
                             REFERENCES study_context_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (math_practice_problem_id, study_context_tag_id)
);

INSERT INTO study_context_tag_membership
  (math_practice_problem_id, study_context_tag_id)
SELECT math_practice_problem_id, study_context_tag_id
  FROM study_context_tag_membership_pre_assignment;

-- Membership first: it is the side holding the reference.
DROP TABLE study_context_tag_membership_pre_assignment;
DROP TABLE study_context_tag_pre_assignment;

-- Rebuilt with the table it belongs to. Filtering the bank to one assignment
-- reads that tag's memberships, which is the direction the primary key cannot
-- serve.
CREATE INDEX idx_study_context_tag_membership_tag
  ON study_context_tag_membership (study_context_tag_id);
