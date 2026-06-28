# TYPES.md — Problem-type registry

Every problem Lightspeed generates comes from a **type** — a generator function
in `problem_types.py`. This file is the canonical view of what types exist, how
each is **presented**, and how each answer is **verified**. Keep it in sync when
you add or change a type (this mirrors the `schema.md` rule for the data model).

Two orthogonal axes:

- **Presentation** — the visual shape of `latex_problem_text`. Pages split it on
  `\n` and render one math block per line, so presentation is encoded purely by
  how many lines the generator emits.
- **Verification** — the independent computational check that must pass before
  `stage()` will accept the problem (golden rule #1: answers are never
  LLM-guessed). `answer_verified_by` is non-NULL only when the check passes;
  otherwise `stage()` reports and drops the item.

## Registry

| Type | Generator | Presentation | Verification method | Always verifiable? |
|------|-----------|--------------|---------------------|--------------------|
| Derivative | `derivative(expr, var="x")` | single-expression | sympy computes `diff(expr)` directly — the differentiation engine is the source of truth; no independent cross-check | **Yes** |
| Indefinite integral | `integral(expr, var="x")` | single-expression | **re-differentiate**: `simplify(diff(answer) − integrand) == 0` | No — NULL on an unevaluated integral or special function (`erf`, `Ei`, …) |
| Definite integral | `definite_integral(expr, a, b, var="x")` | single-expression | antiderivative re-differentiation **and** FTC cross-check `F(b) − F(a) ==` sympy's direct `∫ₐᵇ` | No — NULL on an unevaluated integral or special function |
| Expectation (LOTUS) | `expectation(dist, g, g_latex)` | three-line | (1) density/mass totals 1, (2) sympy returns a closed form, (3) **independent numeric cross-check** at concrete params (mpmath quadrature / truncated sum) | No — NULL if any of the three fails |
| Variance (LOTUS) | `variance(dist)` | three-line | both E[X] and E[X²] pass the expectation check, then `Var = E[X²] − E[X]²` | No — NULL if either moment fails |
| Local extrema | `min_max(expr, var="x")` | single-expression | f'(cp) = 0 at each reported critical point (sympy `simplify` check); f'' ≠ 0 required (second derivative test must be conclusive) | No — NULL if any CP fails the f'=0 check; inconclusive CPs (f''=0) are silently excluded |
| Known value | `known_value(ask_latex, expr, decimals=None)` | single-expression | sympy **evaluates** the expression; the determinate result is the answer. `decimals=n` presents an n-place approximation (e, π) | No — NULL on an indeterminate form (`nan`, or complex-infinity `zoo` from a bare `log(0)` — use a one-sided limit instead) |
| Factorization | `factoring(expr)` | single-expression | **expand-back**: `expand(factored) == expand(expr)` **and** the result is genuinely factored (a product or power, not the input echoed) | No — NULL if the expression is irreducible |
| Algebraic law | `identity(prompt_latex, lhs, rhs)` | single-expression | **numeric cross-check**: lhs and rhs agree at three concrete positive points for every free symbol | No — NULL if the two sides disagree numerically |
| Partial derivative | `partial(expr, wrt)` | single-expression | sympy computes the partial directly (`wrt` = a variable, or a list like `["x","y"]` for higher / mixed partials) — like `derivative`, the engine is the source of truth, no independent cross-check | **Yes** |
| Double integral | `double_integral(expr, inner, outer)` | single-expression | symbolic iterated integration yields a closed form **and** an independent **nested mpmath quadrature** over the region agrees (inner integral re-evaluated at each outer sample, so variable inner limits work) | No — NULL on an unevaluated integral or special function |

`answer_verified_by` stores the verification *tool* — currently always `'sympy'`
when the check passes, NULL when it doesn't. The *method* (the column above) is a
property of the **type**, recorded here rather than per problem row.

Some batches are **themes** that span several types, unified by a batch-level
tag rather than one generator. The **need-to-know** batch (recall facts you
should know cold — constant/trig/log values, exponent & log laws, Pythagorean
identities, standard factorizations, core derivatives & integrals) draws on
`known_value`, `factoring`, and `identity` alongside the reused `derivative` /
`integral` generators. Such themes are expected to grow.

## Presentation styles

- **single-expression** — one line, no `\n`; the whole problem is a single LaTeX
  expression rendered as one math block. *(derivative, integral,
  definite_integral, min_max, mle, known_value, factoring, identity, partial,
  double_integral)*
- **three-line** — three `\n`-separated lines: `X ∼ Dist` / density + support /
  the ask. `add-problems` and `quiz` lay these out as three columns
  (distribution + ask · density · answer); `index` renders one block per line.
  *(expectation, variance)* — when a `Dist` has no `name_latex`, the first line
  is omitted and only two lines are emitted; the current renderers key on
  exactly three lines, so name every distribution until that's generalized.
- **graph** *(planned)* — a problem needing a plotted figure. Not yet
  implemented; it would carry a non-LaTeX payload and need a render path beyond
  the split-on-`\n` convention, plus an explicit presentation signal (line count
  alone can't express it).

## Verification methods

Per golden rule #1, an answer is never LLM-guessed — a computational check
confirms it. The methods in use, weakest to strongest guarantee:

- **direct computation** *(derivative, partial)* — sympy differentiates (a single
  variable, or several in sequence for higher / mixed partials) and the result is
  the answer. The weakest guarantee here: it trusts sympy's `diff`, which is
  reliable for the elementary functions this app uses. No independent
  cross-check, because differentiation has no cheap inverse to test against.
- **re-differentiation** *(indefinite integral)* — the inverse operation grades
  the result: `diff(answer)` must simplify to the integrand. Sound even when
  *computing* the integral was hard.
- **FTC cross-check** *(definite integral)* — in addition to re-differentiating
  the antiderivative, `F(b) − F(a)` must equal sympy's direct definite integral.
- **numeric cross-check** *(LOTUS expectation/variance; algebraic laws; double
  integrals)* — a symbolic claim is compared against an independent numeric
  evaluation. For LOTUS the symbolic value is checked at concrete parameter
  values (mpmath quadrature for continuous, truncated sum for discrete) and the
  density / mass must total 1. For `identity`, the two sides are evaluated at
  three concrete positive points per free symbol (positivity keeps log /
  fractional-power domains valid). For `double_integral`, nested mpmath
  quadrature re-integrates the inner variable at each outer sample — so variable
  inner limits (triangular regions) work — and must match the symbolically
  iterated value. The symbolic engine never grades itself.
- **direct evaluation** *(known values)* — sympy evaluates the expression
  (`sin(pi/2)`, `log(E**2)`, a one-sided `limit` for `\ln 0^+`) and the
  determinate result is the answer; indeterminate forms (`nan`, `zoo`) are
  refused. The weakest guarantee — it trusts sympy's evaluation — but these are
  closed-form constants sympy computes exactly.
- **expand-back** *(factorization)* — the factored form is multiplied out and
  must equal the original (`expand(factored) == expand(expr)`), and must be a
  genuine product/power so an irreducible input isn't echoed as its own
  "factorization."
- **critical-point check** *(local extrema)* — verifies f'(cp) = 0 at each
  reported critical point via `simplify`. The second derivative test classifies
  (local min / local max); points where f'' = 0 are inconclusive and excluded.
- **score equation check** *(MLE)* — differentiates the log-likelihood and
  verifies that the candidate MLE satisfies `d ell / d param = 0` exactly via
  `simplify`. Concavity (confirming it's a maximum, not a minimum) follows from
  the exponential family structure and is not separately checked.

When a check can't be satisfied — special functions (`erf`, `Ei`, `gamma`, …),
unevaluated integrals/sums, or a density that doesn't total 1 —
`answer_verified_by` stays NULL and `stage()` refuses the item.

## Adding a type

1. Write the generator in `problem_types.py`. It must compute the answer with a
   reliable tool **and** independently verify it, returning an `Item` whose
   `answer_verified_by` is set only when the check passes.
2. Add a row here: its presentation style and verification method.
3. If it introduces a new presentation style, also wire the renderers
   (`add-problems.html`, `quiz.html`, `index.html`).
