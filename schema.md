# Lightspeed — Database Schema

**Canonical reference for the SQLite schema.** Source of truth is `db.py`
(the `SCHEMA` string); this file mirrors it in human-readable form.

> ⚠️ **Keep this current.** Any change to the schema in `db.py` (new table,
> column, constraint, enum value, or migration) MUST be reflected here in the
> same change. See CLAUDE.md.

_Last updated: 2026-06-29._

---

## Tables

### `batch`
One generation set (one prompt → many problems). The provenance + type/grouping unit.

| column      | type | notes                                   |
|-------------|------|-----------------------------------------|
| id          | INTEGER PK | |
| prompt      | TEXT NOT NULL | the description that generated the set |
| created_at  | TEXT NOT NULL | ISO-8601 UTC |

### `problem`
A single problem, stored **decomposed** into labeled parts. Belongs to a batch;
lifecycle controlled by `status`. Every non-empty `formula_*` / `expression_*`
renders as its own math block (own copy button on the run page); empty fields are
not displayed.

| column             | type | notes                                              |
|--------------------|------|----------------------------------------------------|
| id                 | INTEGER PK | |
| batch_id           | INTEGER FK → batch(id) | |
| instructions       | TEXT NOT NULL | prose ask ("differentiate", "find the critical points"); may rarely carry LaTeX (e.g. "let X∼Exp(λ)") |
| formula_1          | TEXT | definition/given, raw TeX (e.g. `f(x)=…`, `X∼Dist`, a density + support). NULL when unused |
| formula_2          | TEXT | as above |
| formula_3          | TEXT | as above |
| expression_1       | TEXT | the operand the instruction acts on, raw TeX (`∫…dx`, the function, `E[X²]`). NULL when unused |
| expression_2       | TEXT | as above |
| expression_3       | TEXT | as above |
| answer             | TEXT NOT NULL | raw TeX; sympy output |
| answer_verified_by | TEXT | `NULL` = unverified; `'sympy'` = sympy-confirmed |
| problem_source     | TEXT NOT NULL | e.g. `claude` |
| answer_source      | TEXT NOT NULL | e.g. `sympy` |
| status             | TEXT NOT NULL DEFAULT 'staged' | enum: `staged` \| `approved` \| `rejected` |
| gotcha             | INTEGER NOT NULL DEFAULT 0 | `0/1`; instructive trap, set when curating a batch; weighted in drilling |
| difficulty         | TEXT NOT NULL DEFAULT 'medium' | `easy` \| `medium` \| `hard` (curated) |
| has_e              | INTEGER NOT NULL DEFAULT 0 | `0/1`; involves Euler's e / exp (auto-detected from LaTeX) |
| has_ln             | INTEGER NOT NULL DEFAULT 0 | `0/1`; involves natural log (auto-detected) |
| has_trig           | INTEGER NOT NULL DEFAULT 0 | `0/1`; involves sine/cosine (auto-detected) |
| created_at         | TEXT NOT NULL | ISO-8601 UTC |
| approved_at        | TEXT | set when status → approved; else NULL |

### `type`
A registered problem type — the guardrail binding a type's name to the generator
that produces it and its canonical instruction. Seeded **in full** from the
`problem_types.TYPES` registry at staging time (so `/types` lists every type),
mirroring `TYPES.md`.

| column              | type | notes |
|---------------------|------|-------|
| id                  | INTEGER PK | |
| name                | TEXT NOT NULL UNIQUE | generator-derived id, e.g. `critical_points` |
| generator           | TEXT | the generator function in `problem_types.py` |
| default_instruction | TEXT | canonical instruction, shown as the type's **display name**; `stage()` stamps it onto each problem; NULL for theme types |
| status              | TEXT NOT NULL DEFAULT 'active' | `active` \| `locked`. **Locked** types are excluded from randomly generated sets and hidden (no focus shown) under a toggle on the bank browser. Independent of focus. |

### `type_focus_period`
A type's progress is tracked as a sequence of **focus periods**. The current
focus is the single **open** period (`end_at IS NULL`) — closing it and opening a
new one is a focus transition. Attempts on the type's problems at/after a
period's `start_at` (and before its `end_at`) belong to that period, which is how
"stats during the current focus" are scoped (they reset on each transition).

| column   | type | notes |
|----------|------|-------|
| id       | INTEGER PK | |
| type_id  | INTEGER FK → type(id) | the type this period tracks |
| focus    | TEXT NOT NULL | `accuracy` \| `speed` \| `mastery` (ordered: accurate before fast) |
| start_at | TEXT NOT NULL | ISO-8601 UTC; when this focus began |
| end_at   | TEXT | NULL = current/open period; set when the next transition closes it |

**Invariant:** exactly one open period per type (`init_db` backfills an
`accuracy` one for any type lacking it). **Transitions:** a fresh type starts at
`accuracy`; it auto-graduates to `speed` once **every** approved problem's
most-recent attempt is correct (`db.maybe_graduate`, up-only / accuracy-only —
never auto-demotes, never skips); `speed → mastery` is a manual promotion; the
owner may manually step focus down (or up) one notch at any time
(`db.change_focus`).

### `problem_type`
Join table: which types apply to which problems. Types are applied **per batch**
(every problem in a batch gets the batch's type). Batches are **monotype**, so in
practice this is one type per problem, but the relation is M:N for flexibility.

| column     | type | notes |
|------------|------|-------|
| problem_id | INTEGER FK → problem(id) | part of composite PK |
| type_id    | INTEGER FK → type(id)    | part of composite PK |
| _PK_       | (problem_id, type_id) | |

### `subtype`
A depth-1 label scoped **within a type** — a method/variant (e.g.
`integration_by_parts` under `integral`). Names are unique per type, so the same
name may recur under different types. Generation reuses existing subtypes
(`db.subtypes_by_type`) instead of coining drift variants.

| column  | type | notes |
|---------|------|-------|
| id      | INTEGER PK | |
| type_id | INTEGER FK → type(id) | the type this subtype refines |
| name    | TEXT NOT NULL | e.g. `integration_by_parts`; UNIQUE per `(type_id, name)` |

### `problem_subtype`
Join table: which subtypes apply to which problems. Applied **per batch** (the
batch's subtype, if any). M:N, so a problem can carry more than one (e.g. IBP+trig).

| column     | type | notes |
|------------|------|-------|
| problem_id | INTEGER FK → problem(id) | part of composite PK |
| subtype_id | INTEGER FK → subtype(id) | part of composite PK |
| _PK_       | (problem_id, subtype_id) | |

### `problem_set`
A set of problems run together. Every problem is timed (no timed/untimed split).

| column           | type | notes |
|------------------|------|-------|
| id               | INTEGER PK | |
| n_attempts       | INTEGER NOT NULL DEFAULT 0 | filled on finalize |
| n_correct        | INTEGER NOT NULL DEFAULT 0 | filled on finalize |
| finish_time      | REAL | total seconds across the set; set at finalize |
| time_per_problem | REAL | average seconds; set at finalize |
| created_at       | TEXT NOT NULL | ISO-8601 UTC |

### `attempt`
One attempt at one problem, within a problem_set. Recorded for **every** problem
in the set (each carries its own time), graded or not.

| column              | type | notes |
|---------------------|------|-------|
| id                  | INTEGER PK | |
| problem_set_id      | INTEGER NOT NULL FK → problem_set(id) | |
| problem_id          | INTEGER NOT NULL FK → problem(id) | |
| n_previous_attempts | INTEGER NOT NULL DEFAULT 0 | count of prior attempts at this problem |
| duration_seconds    | REAL | time spent on this problem (recorded when "next" was clicked) |
| completed_at        | TEXT NOT NULL | ISO-8601 UTC |
| answered_correctly  | INTEGER | `1` correct, `0` incorrect, `NULL` ungraded |

---

## Relationships

```
batch 1──* problem *──* type        (via problem_type; applied batch-level, monotype)
type  1──* subtype *──* problem     (subtype scoped to a type; via problem_subtype)
type  1──* type_focus_period        (one open period = current focus)
problem 1──* attempt
problem_set 1──* attempt
```

- A **batch** has many **problems**; a problem belongs to exactly one batch.
- A **problem** has many **types** and a **type** has many problems (M:N via
  `problem_type`). In practice the batch is monotype, so it is one type per problem.
- A **type** has many **subtypes**; a **subtype** belongs to one type and labels
  problems (M:N via `problem_subtype`, optional and applied per batch).
- A **type** has many **focus periods** but exactly one open one (the current
  focus). An attempt belongs to a period implicitly, by falling in its time window.
- A **problem_set** has many **attempts**; each **attempt** also points at the
  single **problem** it recorded.

## Enumerations & conventions

- `problem.status`: `staged` (just generated, awaiting review) → `approved`
  (in the bank) | `rejected` (discarded). Only `approved` problems are eligible
  for the bank/sets.
- `answer_verified_by = 'sympy'` means sympy confirmed the answer (`diff(answer) ==
  integrand`, plus FTC cross-check for definite integrals, etc.); never weaker. `NULL` = unverified.
- `type.status`: `active` (eligible for random sets, shown grouped by focus) |
  `locked` (excluded from random sets, hidden under a toggle, no focus shown).
- `type_focus_period.focus`: `accuracy` → `speed` → `mastery`, ordered. The
  open period (`end_at IS NULL`) is the current focus; "current-period" stats
  count only attempts at/after its `start_at`.
- Dedup key is the tuple of the decomposed statement fields (`instructions` +
  `formula_1..3` + `expression_1..3`), exact match, checked at generation time
  against all problems regardless of status.
- All timestamps are ISO-8601 UTC strings (`db.now()`).

## Migrations

`db.init_db()` creates the schema (`CREATE TABLE IF NOT EXISTS`) then runs
`_migrate()`, an idempotent, non-destructive pass for databases created before a
column/table existed (SQLite has no `ADD COLUMN IF NOT EXISTS`, so it
introspects `PRAGMA table_info` first). Current migrations:

- **focus & lock:** add `type.status` (default `active`) if missing; create
  `type_focus_period`; backfill an open `accuracy` period for any type lacking
  one (anchored at the type's earliest attempt so existing history isn't
  orphaned out of the current period, else `now()`).

`lightspeed.db` is still disposable (recreated on first run), but the focus/lock
change was migrated in place to preserve the existing bank.
