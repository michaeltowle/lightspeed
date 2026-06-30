---
name: fancy-push
description: Snapshot the local Lightspeed DB and push code + snapshot to git so the other laptop can pick it up. Use when the user says "fancy push".
---

# fancy push — ship this laptop's state

Lightspeed's database (`lightspeed.db`) is gitignored; it travels between
laptops as a deterministic text snapshot at `data/lightspeed.sql`. "fancy push"
refreshes that snapshot from the live DB and pushes everything (code + snapshot)
so the other laptop can `fancy pull` it. Single user, one laptop at a time, so
this is a plain last-writer-wins sync — no merging.

Run from the repo root:

1. **Dump the DB** to the tracked snapshot:
   `python db.py dump`
2. **Stage everything** — code changes (if any) plus the refreshed snapshot:
   `git add -A`
3. **Check there's something to commit.** If `git status --short` is empty,
   tell the user nothing changed and stop.
4. **Commit.** Write a concise message describing what changed: summarize real
   code changes if present, otherwise just the data refresh (e.g.
   `fancy push: data snapshot`). End the message with:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
5. **Push** the current branch: `git push`
   (if it fails for a missing upstream, `git push -u origin HEAD`).
6. Report the commit subject and confirm the snapshot was updated.

If `git push` is rejected because the remote is ahead, STOP and tell the user:
the other laptop pushed something not yet pulled here, so they should
`fancy pull` (or reconcile) first rather than force anything.
