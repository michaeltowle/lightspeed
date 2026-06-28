# TYPES.md — Problem-type registry

Every problem Lightspeed generates comes from a **type** — a generator function
in `problem_types.py`. This file is the canonical view of what types exist, how
each is **presented**, and how each answer is **verified**. Keep it in sync when
you add or change a type (this mirrors the `schema.md` rule for the data model).

Two orthogonal axes:

- **Presentation** — which decomposed fields the generator fills. A problem is
  stored as `instructions` + up to three `formula_*` (definitions/givens) + up to
  three `expression_*` (the operand) + `answer`. Each non-empty field renders as
  its own math block (own copy button on the run page); empty fields are skipped.
- **Verification** — the independent computational check that must pass before
  `stage()` will accept the problem (golden rule #1: answers are never
  LLM-guessed). `answer_verified_by` is non-NULL only when the check passes;
  otherwise `stage()` reports and drops the item.

Two finer signals live on the problem, not the type:

- **Subtype** — a depth-1 label *within* a type for a method/variant (e.g.
  `integration_by_parts` / `u_substitution` under `integral`). All problems of a
  type share generator + verification + instructions + layout; the subtype only
  records *how you'd solve it*, so you can drill one technique or the whole type.
  Pass `stage(..., subtype="...")`; **check `db.subtypes_by_type` first** so names
  don't drift. We generate monotype batches, so one subtype per batch.
- **Gotcha** — an instructive trap, flagged with the `gotcha()` wrapper at
  generation time (`gotcha(determinant([[1, 2, 3], [4, 5, 6]]))`). Sets
  `problem.gotcha` so traps get due weight; shown as a badge everywhere except
  while solving (so the trap survives).

Every type carries a canonical **default_instruction** — the imperative shown as
the type's name in the UI (`summation` → *evaluate the sum*). It is the single
source: `stage()` stamps it onto each problem's `instructions`, except where a
generator builds a specialized instruction (e.g. `taylor` encodes the order) and
sets `instructions_specialized`. The live catalog is the `/types` page.

## Registry

| Type | Generator | Presentation | Verification method | Always verifiable? |
|------|-----------|--------------|---------------------|--------------------|
| Derivative | `derivative(expr, var="x")` | single-expression | sympy computes `diff(expr)` directly — the differentiation engine is the source of truth; no independent cross-check | **Yes** |
| Indefinite integral | `integral(expr, var="x")` | single-expression | **re-differentiate**: `simplify(diff(answer) − integrand) == 0` | No — NULL on an unevaluated integral or special function (`erf`, `Ei`, …) |
| Definite integral | `definite_integral(expr, a, b, var="x")` | single-expression | antiderivative re-differentiation **and** FTC cross-check `F(b) − F(a) ==` sympy's direct `∫ₐᵇ` | No — NULL on an unevaluated integral or special function |
| Expectation (LOTUS) | `expectation(dist, g, g_latex)` | three-line | (1) density/mass totals 1, (2) sympy returns a closed form, (3) **independent numeric cross-check** at concrete params (mpmath quadrature / truncated sum) | No — NULL if any of the three fails |
| Variance (LOTUS) | `variance(dist)` | three-line | both E[X] and E[X²] pass the expectation check, then `Var = E[X²] − E[X]²` | No — NULL if either moment fails |
| Local extrema | `min_max(expr, var="x")` | formula-led | f'(cp) = 0 at each reported critical point (sympy `simplify` check); f'' ≠ 0 required (second derivative test must be conclusive). Reports "no local extrema" when there are no critical points | No — NULL if any CP fails the f'=0 check; inconclusive CPs (f''=0) are silently excluded |
| Known value | `known_value(ask_latex, expr, decimals=None)` | single-expression | sympy **evaluates** the expression; the determinate result is the answer. `zoo` → "undefined" (e.g. tan(π/2)); `decimals=n` presents an n-place approximation (e, π) | No — NULL only on `nan` |
| Factorization | `factoring(expr)` | single-expression | **expand-back**: `expand(factored) == expand(expr)` **and** the result is genuinely factored. An irreducible polynomial reports "(irreducible over ℚ)" | No — NULL only if the input is not a polynomial |
| Algebraic law | `identity(prompt_latex, lhs, rhs)` | single-expression | **numeric cross-check**: lhs and rhs agree at three concrete positive points for every free symbol | No — NULL if the two sides disagree numerically |
| Partial derivative | `partial(expr, wrt)` | single-expression | sympy computes the partial directly (`wrt` = a variable, or a list like `["x","y"]` for higher / mixed partials) — like `derivative`, the engine is the source of truth, no independent cross-check | **Yes** |
| Double integral | `double_integral(expr, inner, outer)` | single-expression | symbolic iterated integration yields a closed form **and** an independent **nested mpmath quadrature** over the region agrees (inner integral re-evaluated at each outer sample, so variable inner limits work) | No — NULL on an unevaluated integral or special function |
| Binomial coefficient | `binomial(n, k)` | single-expression | sympy `binomial` directly (k>n → 0; symbolic n fine) | **Yes** |
| Complete the square | `complete_square(expr, var="x")` | single-expression | **expand-back**: `expand(a(x−h)²+k) == expr`. Works bivariate (completes in `var`, others as coefficients) | No — NULL if not degree 2 in `var` |
| Partial fractions | `partial_fractions(expr, var="x")` | single-expression | sympy `apart`; **recombine**: `simplify(together(answer) − expr) == 0` | No — NULL if it can't recombine |
| Higher-order derivative | `higher_derivative(expr, order, var="x")` | single-expression | sympy `diff(expr, var, order)` directly | **Yes** |
| Leibniz rule | `leibniz(expr, t, x, a, b)` | single-expression | sympy's native Leibniz expansion of d/dt ∫ₐᵇ; **numeric finite-difference** cross-check of the t-parametrized integral | No — NULL if the result stays unevaluated or the cross-check fails |
| Improper integral | `improper_integral(expr, a, b, var="x")` | single-expression | sympy returns ±∞ → "diverges"; otherwise **numeric quadrature** cross-check | No — NULL on unevaluated / nan / special function |
| Numeric integral | `numeric_integral(expr, a, b, var="x")` | single-expression | **pure numeric quadrature** (for special-function antiderivatives: gamma / beta / gaussian) | No — NULL if quadrature can't confirm |
| Summation | `summation(expr, k, lo, hi)` | single-expression | divergent → "diverges"; finite numeric → recompute; infinite numeric → partial-sum check; symbolic limit/term → trust sympy | No — NULL on unevaluated / failed cross-check |
| Binomial theorem | `binomial_expand(a, b, n)` | single-expression | sympy `expand((a+b)ⁿ)` directly | **Yes** |
| Taylor / power series | `taylor(expr, var, point, order)` | single-expression | sympy `series(...).removeO()` directly | **Yes** |
| Limit | `limit_(expr, var, point, direction)` | single-expression | sympy `limit`; ±∞ reported as such; `direction="both"` with one-sided disagreement / oscillation (`AccumBounds`, `zoo`) → "does not exist" | **Yes** (a determinate value or an explicit DNE/∞ verdict) |
| Determinant | `determinant(rows)` | single-expression | sympy `det`; non-square → "undefined (not square)" | **Yes** |
| Matrix inverse | `matrix_inverse(rows)` | single-expression | non-square / singular → no-inverse verdict; else **A·A⁻¹ = I** check | No — NULL if A·A⁻¹ ≠ I |
| Quadratic form | `quadratic_form(rows, variables)` | single-expression | sympy `expand(xᵀAx)` directly | **Yes** |
| Switch order | `switch_order(expr, inner, outer, inner2, outer2)` | single-expression | both orderings evaluate to the same value (`simplify(v₁ − v₂) == 0`); answer is the reversed integral | No — NULL if the two orders disagree |
| Critical points | `critical_points(expr, var="x")` | formula-led | f'(cp) = 0 at each reported point; "none" if no real roots, "every x" if f constant | No — NULL if a reported point fails the f'=0 check |

`answer_verified_by` stores the verification *tool* — currently always `'sympy'`
when the check passes, NULL when it doesn't. The *method* (the column above) is a
property of the **type**, recorded here rather than per problem row.

Some categories are **themes** that would span several generators — e.g. a
**need-to-know** recall set (constant/trig/log values, exponent & log laws,
Pythagorean identities, standard factorizations, core derivatives & integrals)
drawing on `known_value`, `factoring`, `identity`, `derivative`, `integral`. A
theme would be a `type` with a NULL `default_instruction` (no single instruction
fits). We currently generate **monotype** batches only — one generator per type —
so no theme types exist yet.

## Presentation styles

Every type also sets `answer`. The label names which statement fields it fills:

- **single-expression** — `instructions` + `expression_1` (one operand block).
  The bulk of types — derivatives, integrals, sums, series, limits, linear
  algebra, matrices, combinatorics, etc.
- **formula-led** — `instructions` + `formula_1` (a definition such as `f(x)=…`),
  no operand block. *(local extrema, critical points)*. `mle` is a hybrid:
  `formula_1` (the iid sampling line) + `expression_1` (the estimator).
- **three-line** *(LOTUS — expectation, variance)* — `formula_1` (`X∼Dist`) +
  `formula_2` (density + support) + `expression_1` (the ask, e.g. `E[X²]`). When
  a `Dist` has no `name_latex`, `formula_1` is omitted; renderers skip empty
  fields, so two formulas renders fine.
- **graph** *(planned)* — a problem needing a plotted figure. Not yet
  implemented; it would carry a non-LaTeX payload and a render path beyond the
  formula/expression fields, plus an explicit presentation signal.

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
- **finite-difference cross-check** *(Leibniz rule)* — the symbolic d/dt is
  compared to a central finite difference of the numerically-integrated,
  t-parametrized integral; handles variable limits and integrands with no
  elementary antiderivative.
- **value-equality** *(switch order of integration)* — the two iterated orders
  must evaluate to the same value; the answer is the order-reversed integral.
- **inverse identity** *(matrix inverse)* — `A·A⁻¹ = I` after `simplify`.
- **recombine** *(partial fractions)* — `together(answer)` must equal the input.
- **direct computation, no cross-check** *(binomial, higher derivative, binomial
  theorem, Taylor series, limit, determinant, quadratic form)* — sympy's
  `binomial` / `diff` / `expand` / `series` / `limit` / `det` is the source of
  truth, as with `derivative`.

Several types answer with a **verdict** rather than a value, and that verdict *is*
the verified result: "diverges" (improper integral / summation where sympy
returns ±∞), "does not exist" (two-sided limit disagreement / oscillation),
"undefined" (`tan(π/2)`, determinant of a non-square matrix), "no inverse
(singular)", "no local extrema", "every x (f constant)". These are correct facts
sympy confirms (by returning ±∞, refusing the operation, or one-sided
disagreement), not numeric values.

When a check can't be satisfied — special functions (`erf`, `Ei`, `gamma`, …),
unevaluated integrals/sums, or a density that doesn't total 1 —
`answer_verified_by` stays NULL and `stage()` refuses the item.

## Adding a type

1. Write the generator in `problem_types.py`. It must compute the answer with a
   reliable tool **and** independently verify it, returning an `Item` whose
   `answer_verified_by` is set only when the check passes.
2. Add a row here: its presentation style and verification method.
3. Add it to the `TYPES` registry in `problem_types.py` (name → generator →
   default_instruction); staging seeds the `type` table from there.
4. If it introduces a new presentation style, also wire the renderers
   (`staged.html`, `set.html`, `index.html`).
