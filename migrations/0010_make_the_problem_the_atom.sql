-- The problem becomes the atom.
--
-- Until now a problem could not exist except as the child of a generation run:
-- named_problem_generator -> problem_set -> math_practice_problem. That single
-- fact is what made an exact serve impossible (a problem read off a screenshot
-- had nowhere to live but as model output), kept tagging coarse (tags hung on
-- the generator, so "status: down" could never mean one problem), and left
-- nothing to verb but a recipe to re-run.
--
-- Here origin stops being a parent and becomes a column. A problem transcribed
-- from a screenshot and one built to order from a prompt are the same kind of
-- row, and everything downstream -- serving, attempting, grading, tagging,
-- drilling -- never asks which it is.
--
-- Past attempts are not carried. They were a nice-to-have, and the shapes on
-- either side of this line do not correspond: an attempt used to point at a
-- problem inside a set, and sets no longer exist.

-- ---------------------------------------------------------------------------
-- Out with the hierarchy. Children first: ON DELETE CASCADE fires on DELETE,
-- never on DROP, so the order here is doing real work rather than decoration.
-- ---------------------------------------------------------------------------
DROP TABLE problem_attempt;
DROP TABLE practice_run;
DROP TABLE math_practice_problem;
DROP TABLE problem_set;

-- ---------------------------------------------------------------------------
-- The screenshots are the one thing genuinely expensive to recreate, so they
-- are carried across before their old table goes. They arrive unattached to any
-- problem, which is exactly what marks them as awaiting transcription -- no
-- flag column, just an absent attachment.
-- ---------------------------------------------------------------------------
CREATE TABLE screenshot_of_record (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mime_type   TEXT    NOT NULL,
  width_px    INTEGER NOT NULL,
  height_px   INTEGER NOT NULL,
  byte_size   INTEGER NOT NULL,
  -- Binary, never base64 -- D1 caps a BLOB at 2,000,000 bytes and base64 would
  -- add ~33% for no benefit.
  image_bytes BLOB    NOT NULL,
  created_at  TEXT    NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO screenshot_of_record
  (mime_type, width_px, height_px, byte_size, image_bytes)
SELECT mime_type, width_px, height_px, byte_size, image_bytes
  FROM math_prompt_image_attachment
 ORDER BY named_problem_generator_id, ordinal;

DROP TABLE math_prompt_image_attachment;

-- Membership is rebuilt rather than altered: it pointed at the generator, and
-- the generator is what this migration removes. The tag catalogue itself is
-- untouched -- the chips, their fields and their colours are the expensive part
-- and they all survive.
DROP TABLE study_context_tag_membership;

DROP TABLE named_problem_generator;

-- ---------------------------------------------------------------------------
-- The atom.
-- ---------------------------------------------------------------------------
CREATE TABLE math_practice_problem (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- A short scannable descriptor, the way a generator used to carry one. This
  -- is what the bank lists; the statement is too long to scan.
  name                          TEXT    NOT NULL,
  -- Mike's own numbering off the page -- "2.1(a)". Shown on the problem page so
  -- it matches the homework in front of him. NULL when nothing numbered it.
  textbook_problem_number_label TEXT,
  -- Self-contained on purpose: a multi-part screenshot's shared stem is folded
  -- into each part at transcription, so a part is workable with nothing else in
  -- view. Model-emitted HTML with LaTeX in $...$; KaTeX renders it client-side.
  statement_html                TEXT    NOT NULL,

  how_this_problem_came_to_be   TEXT    NOT NULL
    CHECK (how_this_problem_came_to_be IN (
      'transcribed_from_a_screenshot_of_record',
      'built_to_order_from_a_prompt',
      'modelled_on_another_problem',
      'isolated_from_one_maneuver'
    )),

  -- Lineage. Both NULL for a problem that arrived by its own intake; exactly one
  -- is set for a problem the app minted from another. A problem with neither is
  -- an unvaried original, which is what the bank lists by default.
  parent_problem_varied_from        INTEGER REFERENCES math_practice_problem(id),
  the_maneuver_it_was_isolated_from INTEGER REFERENCES maneuver(id),

  -- What was actually said to the model to produce this -- prompt, or prompt
  -- plus twist. A problem's minting instruction can be re-run from its row, and
  -- editing anything later cannot rewrite what produced work already done.
  text_that_minted_this_problem TEXT    NOT NULL DEFAULT '',

  -- How this problem is served when nothing says otherwise. Restricted to the
  -- two standing choices: drilling one maneuver is always a deliberate act, so
  -- it is never a default.
  default_service_style         TEXT    NOT NULL DEFAULT 'exact'
    CHECK (default_service_style IN ('exact', 'variant')),

  -- NULL until the maneuver table lands. A problem is mintable and servable
  -- before it is broken down, which is what lets transcription hand back
  -- statements immediately and solve in the background.
  broken_into_maneuvers_at      TEXT,
  created_at                    TEXT    NOT NULL
                                  DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at                   TEXT
);

-- ---------------------------------------------------------------------------
-- One row of a problem's table. The walkthrough is no longer a blob of prose:
-- each step is a row that can be graded, and the last row is the answer.
-- ---------------------------------------------------------------------------
CREATE TABLE maneuver (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  math_practice_problem_id INTEGER NOT NULL
                             REFERENCES math_practice_problem(id) ON DELETE CASCADE,
  ordinal                  INTEGER NOT NULL,
  -- What the step is -- "calculate the rejection region".
  name                     TEXT    NOT NULL,
  -- How to arrive at it, in plain English. Deliberately free of math and
  -- symbols: this column is what the problem page can show as help without
  -- handing over the answer.
  method_text              TEXT    NOT NULL,
  -- The value or expression the step produces. A step with nothing to put here
  -- does not qualify as a maneuver -- that rule is what keeps the table a
  -- ladder of results rather than a narrative with cells drawn round it.
  result_html              TEXT    NOT NULL
                             CHECK (length(trim(result_html)) > 0),
  UNIQUE (math_practice_problem_id, ordinal)
);

-- A screenshot is stored once and attached to each problem read off it, so a
-- three-part page does not store its bytes three times.
CREATE TABLE screenshot_of_record_attachment (
  math_practice_problem_id INTEGER NOT NULL
                             REFERENCES math_practice_problem(id) ON DELETE CASCADE,
  screenshot_of_record_id  INTEGER NOT NULL
                             REFERENCES screenshot_of_record(id) ON DELETE CASCADE,
  ordinal                  INTEGER NOT NULL,
  PRIMARY KEY (math_practice_problem_id, screenshot_of_record_id)
);

-- Tags now hang on the problem, which is the whole point: "status: down" can
-- finally mean one problem rather than a standing practice type.
CREATE TABLE study_context_tag_membership (
  math_practice_problem_id INTEGER NOT NULL
                             REFERENCES math_practice_problem(id) ON DELETE CASCADE,
  study_context_tag_id     INTEGER NOT NULL
                             REFERENCES study_context_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (math_practice_problem_id, study_context_tag_id)
);

-- ---------------------------------------------------------------------------
-- One forward-only pass. There is no set behind it any more: a run is built
-- from whatever was ticked in the bank, so its membership is the attempts.
-- ---------------------------------------------------------------------------
CREATE TABLE practice_run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT    NOT NULL
                 DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);

-- One row per problem in a run, written when the run is built and filled in as
-- it proceeds. Backing out early leaves ungraded rows, which are invisible
-- everywhere -- a square is still earned by grading, never by working.
CREATE TABLE problem_attempt (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  math_practice_problem_id    INTEGER NOT NULL
                                REFERENCES math_practice_problem(id) ON DELETE CASCADE,
  practice_run_id             INTEGER NOT NULL
                                REFERENCES practice_run(id) ON DELETE CASCADE,
  ordinal                     INTEGER NOT NULL,
  -- NULL until the problem is actually worked.
  elapsed_ms                  INTEGER,
  -- 'partial' is not a fourth thing to decide: it is what a mixed set of
  -- maneuver marks rolls up to.
  outcome                     TEXT
                                CHECK (outcome IN ('right', 'partial', 'wrong', 'skipped')),
  -- The maneuver table was consulted mid-attempt. Still a real attempt, just an
  -- assisted one, which is why it is recorded beside the outcome and not
  -- instead of it.
  needed_help_during_attempt  INTEGER NOT NULL DEFAULT 0,
  marked_for_further_practice INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT    NOT NULL
                                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (practice_run_id, ordinal)
);

-- Self-grading, one maneuver at a time. Partial credit falls out of this rather
-- than being a feature beside it, and a one-maneuver problem degenerates to
-- plain right/wrong without a second mechanism.
CREATE TABLE per_maneuver_credit_mark (
  problem_attempt_id INTEGER NOT NULL
                       REFERENCES problem_attempt(id) ON DELETE CASCADE,
  maneuver_id        INTEGER NOT NULL
                       REFERENCES maneuver(id) ON DELETE CASCADE,
  got_it             INTEGER NOT NULL,
  PRIMARY KEY (problem_attempt_id, maneuver_id)
);

-- A professor's standing convention -- "evaluate an improper integral at capital
-- M, then take the limit as M goes to infinity". Injected into the directive
-- that breaks a problem down, so the convention arrives as its own maneuver row
-- and can be marked missed like any other step.
--
-- Scoped to a tag so a 6801 mandate does not leak into other classes; NULL
-- scope means it applies to everything.
CREATE TABLE professorial_style_mandate (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_text            TEXT    NOT NULL,
  study_context_tag_id INTEGER REFERENCES study_context_tag(id) ON DELETE CASCADE,
  created_at           TEXT    NOT NULL
                         DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at          TEXT
);

-- ---------------------------------------------------------------------------
-- Indexes. Each one is a read the app actually makes.
-- ---------------------------------------------------------------------------

-- The bank lists unvaried originals and expands a parent to its variants.
CREATE INDEX idx_math_practice_problem_parent
  ON math_practice_problem (parent_problem_varied_from);
CREATE INDEX idx_math_practice_problem_isolated_from
  ON math_practice_problem (the_maneuver_it_was_isolated_from);
CREATE INDEX idx_math_practice_problem_created_at
  ON math_practice_problem (created_at DESC);

-- A problem's table is always read whole and in order.
CREATE INDEX idx_maneuver_problem
  ON maneuver (math_practice_problem_id, ordinal);

CREATE INDEX idx_screenshot_of_record_attachment_screenshot
  ON screenshot_of_record_attachment (screenshot_of_record_id);

-- The dashboard reads every membership at once, but filtering to one tag reads
-- that tag's, and that is the direction the primary key cannot serve.
CREATE INDEX idx_study_context_tag_membership_tag
  ON study_context_tag_membership (study_context_tag_id);

-- The answers page reads a run's attempts in order; the wall and the ledger
-- read every graded attempt ever, oldest first; a problem's own strip reads its
-- history across runs.
CREATE INDEX idx_problem_attempt_run
  ON problem_attempt (practice_run_id, ordinal);
CREATE INDEX idx_problem_attempt_created_at
  ON problem_attempt (created_at);
CREATE INDEX idx_problem_attempt_problem
  ON problem_attempt (math_practice_problem_id, created_at);

CREATE INDEX idx_professorial_style_mandate_tag
  ON professorial_style_mandate (study_context_tag_id);
