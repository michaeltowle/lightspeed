-- A math prompt Mike authored, stored so it can be replayed against the model.
-- Replay fidelity: model_id and system_prompt are captured per row, so replaying
-- an old prompt reproduces the original request even after those change in code.
CREATE TABLE authored_math_prompt (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_text   TEXT    NOT NULL,
  model_id      TEXT    NOT NULL,
  system_prompt TEXT    NOT NULL,
  reply_text    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per screenshot attached to a prompt.
-- image_bytes is binary, never base64 -- D1 caps a BLOB at 2,000,000 bytes and
-- base64 would add ~33% for no benefit.
CREATE TABLE math_prompt_image_attachment (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  authored_math_prompt_id INTEGER NOT NULL
                            REFERENCES authored_math_prompt(id) ON DELETE CASCADE,
  ordinal                 INTEGER NOT NULL,
  mime_type               TEXT    NOT NULL,
  width_px                INTEGER NOT NULL,
  height_px               INTEGER NOT NULL,
  byte_size               INTEGER NOT NULL,
  image_bytes             BLOB    NOT NULL
);

CREATE INDEX idx_math_prompt_image_attachment_prompt
  ON math_prompt_image_attachment (authored_math_prompt_id, ordinal);

CREATE INDEX idx_authored_math_prompt_created_at
  ON authored_math_prompt (created_at DESC);
