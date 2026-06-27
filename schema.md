# Lightspeed — Database Schema

**Canonical reference for the SQLite schema.** Source of truth is `db.py`
(the `SCHEMA` string + `_migrate`); this file mirrors it in human-readable form.

> ⚠️ **Keep this current.** Any change to the schema in `db.py` (new table,
> column, constraint, enum value, or migration) MUST be reflected here in the
> same change. See CLAUDE.md.

_Last updated: 2026-06-27._

---

## Tables

### `batch`
One generation set (one prompt → many problems). The provenance + tag/grouping unit.

| column      | type | notes                                   |
|-------------|------|-----------------------------------------|
| id          | INTEGER PK | |
| prompt      | TEXT NOT NULL | the description that generated the set |
| created_at  | TEXT NOT NULL | ISO-8601 UTC |

### `problem`
A single problem. Belongs to a batch; lifecycle controlled by `status`.

| column             | type | notes                                              |
|--------------------|------|----------------------------------------------------|
| id                 | INTEGER PK | |
| batch_id           | INTEGER FK → batch(id) | |
| latex_problem_text | TEXT NOT NULL | raw TeX, no surrounding `$`. May contain `\n` to mark line breaks (e.g. probability problems render as 3 lines); each renderer splits on `\n` into one math block per line. |
| latex_answer_text  | TEXT NOT NULL | raw TeX; sympy output |
| answer_verified_by | TEXT | `NULL` = unverified; `'sympy'` = sympy-confirmed |
| problem_source     | TEXT NOT NULL | e.g. `claude` |
| answer_source      | TEXT NOT NULL | e.g. `sympy` |
| status             | TEXT NOT NULL DEFAULT 'staged' | enum: `staged` \| `approved` \| `rejected` |
| starred            | INTEGER NOT NULL DEFAULT 0 | `0/1`; user-marked "interesting" |
| problematic        | INTEGER NOT NULL DEFAULT 0 | `0/1`; user-flagged "something wrong" (set from quiz/practice) |
| created_at         | TEXT NOT NULL | ISO-8601 UTC |
| approved_at        | TEXT | set when status → approved; else NULL |

### `tag`
A category. Assigned by Claude at the batch level (see relationships).

| column       | type | notes |
|--------------|------|-------|
| id           | INTEGER PK | |
| display_text | TEXT NOT NULL UNIQUE | |

### `problem_tag`
Join table: which tags apply to which problems. Tags are applied **per batch**
(every problem in a batch gets the batch's tags), but stored per problem here.

| column     | type | notes |
|------------|------|-------|
| problem_id | INTEGER FK → problem(id) | part of composite PK |
| tag_id     | INTEGER FK → tag(id)     | part of composite PK |
| _PK_       | (problem_id, tag_id) | |

### `problem_list`
A problem set to be completed (quiz = timed, practice = untimed).

| column           | type | notes |
|------------------|------|-------|
| id               | INTEGER PK | |
| is_timed         | INTEGER NOT NULL | `0/1` |
| n_attempts       | INTEGER NOT NULL DEFAULT 0 | filled on finalize |
| n_correct        | INTEGER NOT NULL DEFAULT 0 | filled on finalize |
| finish_time      | REAL | seconds; NULL if untimed |
| time_per_problem | REAL | seconds; NULL if untimed |
| created_at       | TEXT NOT NULL | ISO-8601 UTC |

### `attempt`
One graded attempt at one problem, within a problem_list.

| column              | type | notes |
|---------------------|------|-------|
| id                  | INTEGER PK | |
| problem_list_id     | INTEGER NOT NULL FK → problem_list(id) | |
| problem_id          | INTEGER NOT NULL FK → problem(id) | |
| n_previous_attempts | INTEGER NOT NULL DEFAULT 0 | count of prior attempts at this problem |
| completed_at        | TEXT NOT NULL | ISO-8601 UTC |
| answered_correctly  | INTEGER | `1` correct, `0` incorrect, `NULL` ungraded |

---

## Relationships

```
batch 1──* problem *──* tag        (via problem_tag; applied batch-level)
problem 1──* attempt
problem_list 1──* attempt
```

- A **batch** has many **problems**; a problem belongs to exactly one batch.
- A **problem** has many **tags** and a **tag** has many problems (M:N via
  `problem_tag`). In practice tags are assigned to the whole batch at generation.
- A **problem_list** has many **attempts**; each **attempt** also points at the
  single **problem** it graded.

## Enumerations & conventions

- `problem.status`: `staged` (just generated, awaiting review) → `approved`
  (in the bank) | `rejected` (discarded). Only `approved` problems are eligible
  for the bank/quizzes.
- `answer_verified_by = 'sympy'` means sympy confirmed the answer (`diff(answer) ==
  integrand`, plus FTC cross-check for definite integrals); never weaker. `NULL` = unverified.
- Dedup key is `problem.latex_problem_text` (exact match), checked at generation
  time against all problems regardless of status.
- All timestamps are ISO-8601 UTC strings (`db.now()`).

## Migrations

`db._migrate()` runs on `init_db()` and is idempotent. Current migrations:
- add `problem.starred` if missing (for DBs created before it existed).
- add `problem.problematic` if missing (for DBs created before it existed).
- rename `problem.answer_is_verified` (INTEGER 0/1) → `answer_verified_by` (TEXT NULL/'sympy') for existing DBs.
