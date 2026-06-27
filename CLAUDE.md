# CLAUDE.md — Lightspeed

Personal calculus-practice app. Replaces a Jupyter+sympy notebook workflow:
generate verified problems, curate them into a bank, drill them, and track reps /
recency / weak spots. Single user (the repo owner).

## Golden rules

1. **Answers are never LLM-guessed.** Claude picks the problem; **sympy** computes
   AND independently verifies the answer (`problem_types.py`). `answer_verified_by
   = 'sympy'` only when a check confirms it (`diff(answer) == integrand`; FTC
   cross-check for definite integrals; numeric cross-check for LOTUS; special
   functions / unevaluated integrals are left NULL). Each type's verification
   method is registered in `TYPES.md`. If sympy can't reliably do a requested
   type, say so — don't guess.
2. **Update `schema.md` whenever the DB schema changes.** Any new table, column,
   constraint, enum value, or migration in `db.py` MUST be mirrored in
   `schema.md` in the same change. The owner relies on `schema.md` as the
   canonical, always-current picture of the data model. Don't let it drift.
3. **Update `TYPES.md` whenever a problem type changes.** Any new generator in
   `problem_types.py`, or a change to a type's presentation style or verification
   method, MUST be mirrored in `TYPES.md` in the same change. It's the canonical
   registry of problem types — don't let it drift.
4. **Update `README.md` when behavior/flow changes**, and this file when a rule
   or convention changes.
5. **Only ever run ONE server on :8000.** A stale process silently answers with
   old code (we've been bitten by this). Kill existing listeners before
   restarting.

## How it runs

- `python server.py` → serves pages + JSON API at http://localhost:8000/
  (stdlib `http.server`; no LLM/sympy at runtime).
- Generation happens in **Claude Code sessions**, not in the app: in a session,
  call `generate.py` helpers, then `stage(prompt, items, tags=[...])`.

Zero-install: Python stdlib + sympy only. No API key, no Node.

## Conventions

- **Generation → staging → review.** Generated problems are `staged`; the owner
  reviews at `/add-problems`. **Approve is batch-level** (one button per batch);
  **reject is per-problem**; **star** flags interesting problems. No tag-picking
  in the UI.
- **Tags are batch-level and Claude-assigned** at generation time. The owner will
  not hand-maintain tags; bulk re-tagging is a script Claude runs over the DB.
- **Batch size ~50 problems** per prompt. Keep prompts homogeneous (one technique
  per prompt) so batch-level tags stay meaningful.
- **Dedup at generation time** on exact `latex_problem_text`, against the whole DB
  regardless of status (so rejected problems never resurface).

## Files

- `db.py` — SQLite schema + all data access (owns migrations).
- `problem_types.py` — sympy compute+verify generators (one function per problem
  type). Registered in `TYPES.md`.
- `generate.py` — `stage()` (dedup + staging).
- `server.py` — local server: pages + JSON API.
- `add-problems.html` — review/approve/reject/star surface (interim UI).
- `index.html` — browse bank by tag, select, launch quiz/practice (wireframe).
- `quiz.html` — timed/untimed practice + click-to-grade + finalize (wireframe).
- `lightspeed.db` — created on first run; disposable.

## Docs

- `schema.md` — canonical data model (keep current — rule #2).
- `TYPES.md` — canonical problem-type registry: presentation style + verification
  method per type (keep current — rule #3).
- `README.md` — full pipeline, rationale, run instructions.
- `add-problems-ui-brief.md` — design brief for the add-problems screen
  (visual design is done separately in Claude Design).

## Status

All three pages are functional as plain wireframes (final visual design comes
from Claude Design): `add-problems.html` (review/approve), `index.html` (browse +
build set), `quiz.html` (run + grade + finalize). The full loop works end to end.
