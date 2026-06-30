---
name: fancy-pull
description: Pull the latest code + DB snapshot from git and rebuild the local Lightspeed DB from it. Use when the user says "fancy pull".
---

# fancy pull — adopt the other laptop's state

Pull the latest from git, then rebuild the local DB from the snapshot at
`data/lightspeed.sql`. This is a full replace (last-writer-wins); the current
`lightspeed.db` is backed up to `lightspeed.db.bak` first, so a mistaken load is
recoverable.

Run from the repo root:

1. **Pull**: `git pull`. If it reports conflicts or is blocked by local
   uncommitted changes, STOP and surface it — do not force or stash silently.
2. **Rebuild the DB** from the snapshot: `python db.py load`
   (backs up the existing `lightspeed.db` → `.bak`, then loads the snapshot and
   applies any newer migrations on top).
3. **Restart the server** so it serves the new data — only ever ONE on :8000:
   `lsof -ti tcp:8000 | xargs kill -9 2>/dev/null` then start `python server.py`
   fresh (in the background).
4. Report the row counts (problems / attempts) so the user can sanity-check that
   the sync landed — e.g.
   `python -c "import db; c=db.connect(); print(c.execute('SELECT COUNT(*) FROM problem').fetchone()[0], 'problems,', c.execute('SELECT COUNT(*) FROM attempt').fetchone()[0], 'attempts')"`
