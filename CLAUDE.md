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
  call `generate.py` helpers, then `stage(prompt, items, type="...")`.

Zero-install: Python stdlib + sympy only. No API key, no Node.

## Conventions

- **Generation → staging → review.** Generated problems are `staged`; the owner
  reviews at `/staged`. **Approve is batch-level** (one button per batch);
  **reject is per-problem**. No type-picking in the UI.
- **Types are batch-level and Claude-assigned** at generation time (one type per
  batch — batches are monotype). A type binds its generator + canonical
  instruction (`problem_types.TYPES`); the owner does not hand-maintain them. The
  `default_instruction` is the type's **display name** in the UI and the single
  source: `stage()` stamps it onto every problem (a generator that specialized
  its instruction sets `instructions_specialized` to keep its own).
- **Subtypes** are an optional depth-1 label *within* a type (method/variant, e.g.
  `integration_by_parts`). Before coining one, **check existing subtypes for that
  type** (`db.subtypes_by_type`) so names don't drift. **Gotchas** (instructive
  traps) are flagged with the `gotcha()` wrapper at generation so they get due
  weight.
- **Batch size ~50 problems** per prompt. Keep prompts homogeneous (one technique
  per prompt) so the batch's single type stays meaningful.
- **Dedup at generation time** on the decomposed statement fields (`instructions`
  + `formula_*` + `expression_*`), against the whole DB regardless of status (so
  rejected problems never resurface).

## Files

- `db.py` — SQLite schema + all data access (owns the schema).
- `problem_types.py` — sympy compute+verify generators (one function per problem
  type) + the `TYPES` registry. Registered in `TYPES.md`.
- `generate.py` — `stage()` (dedup + staging; one `type=` per batch).
- `server.py` — local server: pages + JSON API.
- `staged.html` — review/approve/reject surface (interim UI).
- `index.html` — browse bank by type, select, start a set (wireframe).
- `set.html` — one-at-a-time timed run + click-to-grade + finalize (wireframe).
- `types.html` — read-only catalog of all problem types (interim UI).
- `lightspeed.db` — created on first run; disposable.

## Docs

- `schema.md` — canonical data model (keep current — rule #2).
- `TYPES.md` — canonical problem-type registry: presentation style + verification
  method per type (keep current — rule #3).
- `README.md` — full pipeline, rationale, run instructions.

## Status

All three pages are functional as plain wireframes (final visual design comes
from Claude Design): `staged.html` (review/approve), `index.html` (browse +
build set), `set.html` (run + grade + finalize). The full loop works end to end.
