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
  weight — a gotcha is anything not literally doable (det of a non-square matrix),
  atypical in an interesting way (a definite integral that's 0), or where a
  general rule is violated (∫xⁿ vs n=−1 → ln).
- **Difficulty** (`easy`/`medium`/`hard`) is curated: `stage(difficulty=...)` sets
  the batch default, per-item `easy()`/`hard()` wrappers override. The **content
  flags** `has_e` / `has_ln` / `has_trig` are auto-detected from each problem's
  LaTeX (no curation).
- **Batch size ~50 problems** per prompt. Keep prompts homogeneous (one technique
  per prompt) so the batch's single type stays meaningful.
- **Dedup at generation time** on the decomposed statement fields (`instructions`
  + `formula_*` + `expression_*`), against the whole DB regardless of status (so
  rejected problems never resurface).
- **Focus & lock are runtime state on a type, not generation concerns.** Each
  type carries a *focus* — `accuracy → speed → mastery` (accurate before fast) —
  tracked as `type_focus_period` rows (the open one is current). A fresh type
  starts at `accuracy` and **auto-graduates to speed** once every approved
  problem's *most-recent* attempt is correct; `speed → mastery` is a manual
  promote; the owner can step focus down/up any time. Graduation is up-only
  (never auto-demotes). Period-scoped stats reset on each transition. A type's
  `status` (`active`/`locked`) separately holds it out of random sets. These are
  set through the app (the index page / API), **not** at generation — `stage()`
  does not touch focus or lock.

## Files

- `db.py` — SQLite schema + all data access (owns the schema).
- `problem_types.py` — sympy compute+verify generators (one function per problem
  type) + the `TYPES` registry. Registered in `TYPES.md`.
- `generate.py` — `stage()` (dedup + staging; one `type=` per batch).
- `server.py` — local server: pages + JSON API.
- `staged.html` — review/approve/reject surface (interim UI).
- `index.html` — browse bank by type (grouped into accuracy/speed/mastery focus
  columns; lock to hide), select problems, start a set (wireframe).
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
