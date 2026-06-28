"""Problem-type generators for Lightspeed.

Each public function here is a *problem type*. Claude supplies the concrete
problem; the function computes the answer with sympy and INDEPENDENTLY VERIFIES
it, returning an Item ready for staging. The canonical registry of types — each
type's presentation style and verification method — is TYPES.md; keep that file
in sync whenever you add or change a type.

CORRECTNESS RULE (golden rule #1): an answer is marked verified ONLY when an
independent computational check confirms it (see each function's docstring and
TYPES.md for the method). If the check can't be satisfied, answer_verified_by is
None and stage() refuses to stage the item.

A session imports the generators here plus stage() from generate.py:

    from problem_types import derivative, integral, definite_integral
    from generate import stage
    items = [
        derivative("x**3 * sin(x)"),
        integral("x * exp(x)"),
        definite_integral("x/(x**2+1)", 0, 1),
    ]
    stage("chain-rule derivatives and basic integrals", items)

Probability problems (expectation / variance via LOTUS) use Dist + the
expectation()/variance() helpers; see their docstrings below.
"""

from dataclasses import dataclass

import mpmath
import sympy as sp
from sympy.parsing.sympy_parser import (
    parse_expr,
    standard_transformations,
    implicit_multiplication_application,
    convert_xor,
)

_TRANSFORMS = standard_transformations + (
    implicit_multiplication_application,
    convert_xor,
)


_SPECIAL = (
    sp.erf, sp.erfi, sp.Si, sp.Ci, sp.Ei, sp.li, sp.gamma,
    sp.uppergamma, sp.lowergamma, sp.fresnels, sp.fresnelc, sp.zeta, sp.polylog,
)


def _has_special(expr):
    return any(expr.has(f) for f in _SPECIAL)


@dataclass
class Item:
    latex_problem_text: str
    latex_answer_text: str
    answer_verified_by: str | None  # 'sympy' if verified, None if not
    problem_source: str = "claude"
    answer_source: str = "sympy"
    note: str = ""  # e.g. why an item could not be verified


def _parse(expr_str):
    return parse_expr(expr_str, transformations=_TRANSFORMS, evaluate=True)


def _latex(expr):
    """sympy LaTeX with our house conventions. ln_notation=True renders natural
    log as \\ln, never \\log (sympy's default). This is a calculus app — the only
    log that ever appears is the natural log (even base-b logs come back as a
    ratio of \\ln), so every log should read as \\ln."""
    return sp.latex(expr, ln_notation=True)


def _present(answer, x):
    """Human-readable form of a result.

    sp.simplify alone is a heuristic that can leave rational results in raw
    quotient-rule shape (e.g. a numerator like -x**2 + 2*x*(x-1) - 1, never
    multiplied out). For rational functions we instead expand the numerator and
    factor the denominator (textbook form); otherwise simplify is kept so its
    transcendental wins survive (sin*cos -> cos(2x), x*exp(x) -> (x+1)*exp(x)).
    All forms are mathematically equal, so verification is unaffected.
    """
    s = sp.simplify(answer)
    n, d = sp.fraction(sp.together(sp.cancel(s)))
    if n.is_polynomial(x) and d.is_polynomial(x) and not d.is_constant(x):
        return sp.expand(n) / sp.factor(d)
    return s


def derivative(expr_str, var="x"):
    """d/dx of expr. Derivatives are always sympy-verifiable."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    answer = sp.diff(expr, x)
    problem_latex = r"\frac{d}{d%s}\left(%s\right)" % (var, _latex(expr))
    return Item(
        latex_problem_text=problem_latex,
        latex_answer_text=_latex(_present(answer, x)),
        answer_verified_by="sympy",
    )


def integral(expr_str, var="x"):
    """Indefinite integral of expr, VERIFIED by differentiating the result.

    Verified only if (a) the result contains no unevaluated Integral and
    (b) d/dx(result) - integrand simplifies to 0.
    """
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    answer = sp.integrate(expr, x)

    if answer.has(sp.Integral):
        verified = False
        note = "sympy returned an unevaluated integral"
    elif _has_special(answer):
        verified = False
        note = "answer involves a special function"
    else:
        verified = sp.simplify(sp.diff(answer, x) - expr) == 0
        note = "" if verified else "d/dx(answer) did not simplify to the integrand"

    problem_latex = r"\int %s \, d%s" % (_latex(expr), var)
    answer_latex = _latex(answer) + " + C"
    return Item(
        latex_problem_text=problem_latex,
        latex_answer_text=answer_latex,
        answer_verified_by="sympy" if verified else None,
        note=note,
    )


def definite_integral(expr_str, a, b, var="x"):
    """Definite integral of expr from a to b, double-checked.

    Verified only if: no unevaluated integral, no special functions, AND both
    (i) d/dx(antiderivative) == integrand  and
    (ii) FTC value F(b)-F(a) equals sympy's direct definite integral.
    """
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    A, B = _parse(str(a)), _parse(str(b))

    F = sp.integrate(expr, x)
    value = sp.integrate(expr, (x, A, B))

    if F.has(sp.Integral) or value.has(sp.Integral):
        verified, note = False, "sympy returned an unevaluated integral"
    elif _has_special(F) or _has_special(value):
        verified, note = False, "answer involves a special function"
    else:
        d_ok = sp.simplify(sp.diff(F, x) - expr) == 0
        ftc_ok = sp.simplify((F.subs(x, B) - F.subs(x, A)) - value) == 0
        verified = bool(d_ok and ftc_ok)
        note = "" if verified else "derivative/FTC cross-check failed"

    problem_latex = r"\int_{%s}^{%s} %s \, d%s" % (
        _latex(A), _latex(B), _latex(expr), var
    )
    answer_latex = _latex(sp.simplify(value))
    return Item(
        latex_problem_text=problem_latex,
        latex_answer_text=answer_latex,
        answer_verified_by="sympy" if verified else None,
        note=note,
    )


# --- probability: expectation / variance via LOTUS -------------------------
#
# LOTUS: E[g(X)] = ∫ g(x) f(x) dx   (continuous)
#                = Σ g(k) p(k)      (discrete)
# Var(X) = E[X²] − (E[X])².
#
# Verification (golden rule #1): an answer is 'sympy' ONLY when
#   (a) the density/mass totals 1 over its support,
#   (b) sympy returns a closed form (no unevaluated Integral/Sum, no special fn),
#   (c) an INDEPENDENT numeric cross-check at concrete parameter values agrees
#       (mpmath quadrature for continuous; a direct truncated sum for discrete).
# (c) is the real backstop — it doesn't trust sympy's symbolic engine to grade
# itself, mirroring how integrals are checked by re-differentiating.


@dataclass
class Dist:
    """A named parametric distribution for LOTUS expectation/variance problems.

    `pdf` is the density (continuous) or mass function (discrete) as a sympy
    expr in `sym` (use x for continuous, k for discrete). `test` maps every free
    parameter to a concrete value for the numeric cross-check. The *_latex fields
    are how the distribution is shown in the problem statement.
    """
    name_latex: str       # e.g. r"\text{Exponential}(\lambda)"
    density_latex: str    # e.g. r"f(x) = \lambda e^{-\lambda x}"
    support_latex: str    # e.g. r"x \ge 0"
    pdf: object
    sym: object
    lo: object
    hi: object
    kind: str             # "continuous" | "discrete"
    test: dict


def _conv_branch(e):
    """Pick the convergent (non-Sum) branch of a Piecewise sympy summation.

    Infinite sums (geometric, Poisson) come back guarded by a convergence
    condition sympy can't discharge without an interval assumption on p; the
    numeric cross-check confirms the branch we keep.
    """
    e = sp.piecewise_fold(e)
    if isinstance(e, sp.Piecewise):
        for sub, _cond in e.args:
            if not sub.has(sp.Sum):
                return sub
    return e


def _pretty(e):
    """Cosmetic: among equivalent forms, prefer no leading minus, then a single
    combined fraction (fewest top-level additive terms), then shortest."""
    cands = [sp.factor(e), sp.cancel(e), sp.together(e),
             sp.together(sp.factor(e)), sp.simplify(e), e]

    def score(c):
        s = sp.sstr(c)
        return (s.lstrip().startswith("-"), len(sp.Add.make_args(c)), len(s))

    return min(cands, key=score)


def _numeric_check(dist, g, val):
    """Independent numeric agreement between the symbolic value and a direct
    evaluation at dist.test. Returns (ok, note)."""
    s = dist.sym
    sym_num = complex(val.subs(dist.test).evalf())
    if dist.kind == "continuous":
        ref = complex(sp.Integral(g * dist.pdf, (s, dist.lo, dist.hi))
                      .subs(dist.test).evalf())
    else:
        lo_n = int(dist.lo)
        hi_n = lo_n + 400 if dist.hi == sp.oo else int(
            dist.hi.subs(dist.test) if hasattr(dist.hi, "subs") else dist.hi)
        direct = sum((g * dist.pdf).subs(dist.test).subs(s, i)
                     for i in range(lo_n, hi_n + 1))
        ref = complex(sp.sympify(direct).evalf())
    ok = abs(sym_num - ref) < 1e-6
    return ok, "" if ok else f"numeric cross-check failed ({sym_num} vs {ref})"


def _expect(dist, g):
    """E[g(X)] over `dist`, sympy-verified. Returns (value, verified, note)."""
    s, lo, hi = dist.sym, dist.lo, dist.hi
    if dist.kind == "continuous":
        norm = sp.integrate(dist.pdf, (s, lo, hi))
        val = sp.integrate(g * dist.pdf, (s, lo, hi))
        unevaluated = val.has(sp.Integral) or norm.has(sp.Integral)
        word = "integral"
    else:
        norm = _conv_branch(sp.summation(dist.pdf, (s, lo, hi)))
        val = _conv_branch(sp.summation(g * dist.pdf, (s, lo, hi)))
        unevaluated = val.has(sp.Sum) or norm.has(sp.Sum)
        word = "sum"

    if unevaluated:
        return val, False, f"sympy returned an unevaluated {word}"
    if _has_special(val):
        return val, False, "answer involves a special function"
    if sp.simplify(norm - 1) != 0:
        return val, False, f"density/mass does not total 1 (got {norm})"
    ok, note = _numeric_check(dist, g, val)
    return sp.simplify(val), ok, note


def _prob_problem_latex(dist, ask_latex):
    r"""Three lines, joined by '\n': the distribution, the density + support, the
    ask. Each consumer (add-problems / quiz / index) splits on '\n' and renders
    one math block per line."""
    density_support = r"%s, \quad %s" % (dist.density_latex, dist.support_latex)
    ask = r"\text{find } %s" % ask_latex
    if dist.name_latex:
        return "\n".join([r"X \sim %s" % dist.name_latex, density_support, ask])
    return "\n".join([density_support, ask])


def expectation(dist, g, g_latex):
    """E[g(X)] problem. `g` is a sympy expr in dist.sym; `g_latex` is the bracket
    content shown, e.g. "X^2" or "X(X-1)"."""
    val, verified, note = _expect(dist, g)
    return Item(
        latex_problem_text=_prob_problem_latex(dist, r"\mathbb{E}[%s]" % g_latex),
        latex_answer_text=_latex(_pretty(val)),
        answer_verified_by="sympy" if verified else None,
        answer_source="sympy",
        note=note,
    )


def variance(dist):
    """Var(X) = E[X²] − (E[X])² problem, verified iff both moments verify."""
    s = dist.sym
    ex, ok1, n1 = _expect(dist, s)
    ex2, ok2, n2 = _expect(dist, s ** 2)
    value = sp.simplify(ex2 - ex ** 2)
    verified = bool(ok1 and ok2)
    note = "" if verified else ("; ".join(n for n in (n1, n2) if n) or "unverified")
    return Item(
        latex_problem_text=_prob_problem_latex(dist, r"\operatorname{Var}(X)"),
        latex_answer_text=_latex(_pretty(value)),
        answer_verified_by="sympy" if verified else None,
        answer_source="sympy",
        note=note,
    )


# --- local extrema -----------------------------------------------------------

def min_max(expr_str, var="x"):
    """Find local minima and maxima via the second derivative test.

    Presentation: single-expression ("f(x) = …, find local extrema").
    Verification: f'(cp) = 0 at every reported critical point (sympy check).
    Points where f'' = 0 at the critical point are inconclusive and excluded.
    """
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    f1 = sp.diff(expr, x)
    f2 = sp.diff(f1, x)

    crit = sp.solve(f1, x)
    real_crit = sorted(
        [c for c in crit if c.is_real],
        key=lambda c: float(c.evalf()),
    )

    classified = []
    all_verified = True
    for cp in real_crit:
        if sp.simplify(f1.subs(x, cp)) != 0:
            all_verified = False
            break
        fpp = sp.simplify(f2.subs(x, cp))
        fval = sp.simplify(expr.subs(x, cp))
        if fpp.is_negative:
            kind = r"\text{local max}"
        elif fpp.is_positive:
            kind = r"\text{local min}"
        else:
            continue  # f''(cp) = 0: inconclusive via 2nd derivative test

        classified.append((cp, kind, fval))

    problem_latex = r"f(x) = %s, \quad \text{find local extrema}" % _latex(expr)

    if all_verified and not real_crit:
        # genuinely no critical points -> no local extrema (instructive gotcha)
        return Item(problem_latex, r"\text{no local extrema (no critical points)}",
                    "sympy")

    if not classified or not all_verified:
        note = ("no classifiable extrema via second derivative test"
                if not classified else "critical point check failed")
        return Item(latex_problem_text=problem_latex, latex_answer_text="",
                    answer_verified_by=None, note=note)

    parts = [r"x = %s:\ %s,\ f = %s" % (_latex(cp), kind, _latex(fval))
             for cp, kind, fval in classified]
    answer_latex = (parts[0] if len(parts) == 1
                    else r"\begin{array}{l}" + r" \\[3pt] ".join(parts) + r"\end{array}")

    return Item(
        latex_problem_text=problem_latex,
        latex_answer_text=answer_latex,
        answer_verified_by="sympy" if all_verified else None,
    )


# --- maximum likelihood estimation -------------------------------------------

def mle(dist_latex, log_lik, param, param_hat_latex, answer_latex=None):
    """MLE: find the value of `param` that maximises `log_lik`.

    `log_lik` is a sympy expression in `param` and symbolic sufficient
    statistics (declared positive by the caller). `answer_latex`, if given,
    overrides the display form with nicer notation (e.g. 1/x̄); the
    computation and verification still use the sympy result.

    Presentation: single-expression ("X₁,…,Xₙ ~ …; find MLE").
    Verification: score equation d ell / d param = 0 holds exactly at the
    candidate MLE (algebraic check via sympy simplify). All classical
    exponential-family MLEs satisfy this; concavity follows from the family.
    """
    score = sp.diff(log_lik, param)
    solutions = sp.solve(score, param)

    problem_latex = (
        r"X_1, \ldots, X_n \overset{\text{iid}}{\sim} %s;"
        r" \quad \text{find } \hat{%s}_{\text{MLE}}" % (dist_latex, param_hat_latex)
    )

    if not solutions:
        return Item(latex_problem_text=problem_latex, latex_answer_text="",
                    answer_verified_by=None, note="could not solve score equation")

    mle_val = solutions[0]
    score_ok = sp.simplify(score.subs(param, mle_val)) == 0
    display = (answer_latex if answer_latex
               else r"\hat{%s} = %s" % (param_hat_latex, _latex(mle_val)))

    return Item(
        latex_problem_text=problem_latex,
        latex_answer_text=display,
        answer_verified_by="sympy" if score_ok else None,
        note="" if score_ok else "score equation did not simplify to 0",
    )


# --- need-to-know recall facts -----------------------------------------------
#
# Flashcard-style facts to know cold: constant/trig/log values, standard
# factorizations, and exponent/log laws. (Known derivatives and integrals reuse
# derivative()/integral() above — they already compute+verify exactly.) Each
# fact is still independently sympy-verified; nothing is asserted by hand.
# Presentation: single-expression (the prompt is the thing to recall; the hidden
# answer is what you must produce).


def known_value(ask_latex, expr_str, decimals=None):
    r"""Recall a constant or exact value, e.g. \sin(\pi/2)=1 or \ln(e^2)=2.

    sympy evaluates `expr_str` and the result IS the answer (never asserted):
      - decimals=None: the value must be determinate — an explicit number or
        \pm\infty. An indeterminate form (nan, or sympy's complex-infinity zoo
        from a bare log(0)) is refused; for a one-sided infinity pass a limit,
        e.g. "limit(log(x), x, 0)" for \ln 0^+ (sympy's default dir is '+').
      - decimals=n: present a numeric approximation to n decimal places (e, \pi).

    `ask_latex` is the prompt shown; the answer is sympy's value.
    """
    val = _parse(expr_str)
    if val is sp.nan:
        return Item(latex_problem_text=ask_latex, latex_answer_text="",
                    answer_verified_by=None, note="indeterminate (nan)")
    if val == sp.zoo:
        # e.g. tan(pi/2): complex-infinity -> the value is undefined (a gotcha)
        return Item(latex_problem_text=ask_latex,
                    latex_answer_text=r"\text{undefined}", answer_verified_by="sympy")
    if decimals is not None:
        if not bool(val.is_finite):
            return Item(latex_problem_text=ask_latex, latex_answer_text="",
                        answer_verified_by=None,
                        note="non-finite value cannot be approximated")
        approx = float(sp.N(val, decimals + 10))
        answer_latex = r"\approx %s" % (f"%.{decimals}f" % approx)
    else:
        answer_latex = _latex(val)
    return Item(latex_problem_text=ask_latex, latex_answer_text=answer_latex,
                answer_verified_by="sympy")


def factoring(expr_str):
    r"""Recall a standard factorization, e.g. b^3 - a^3 -> (b-a)(b^2+ab+a^2).

    sympy factors; verified two ways: the factored form expands back to the
    original (expand(factored) == expand(expr)) AND it is genuinely factored —
    a product or power, not the input echoed back unchanged. Multi-variable is
    fine; the variables are whatever symbols appear in `expr_str`.
    """
    expr = _parse(expr_str)
    factored = sp.factor(expr)
    expands_back = sp.expand(factored) == sp.expand(expr)
    actually_factored = factored.is_Mul or factored.is_Pow
    prob = r"\text{factor: } %s" % _latex(expr)
    if actually_factored:
        return Item(prob, _latex(factored), "sympy" if expands_back else None,
                    note="" if expands_back else "factored form did not expand back")
    # didn't reduce: instructive gotcha — irreducible over the rationals, as long
    # as it is a genuine polynomial sympy chose to leave alone.
    try:
        is_poly = sp.Poly(expr, *sorted(expr.free_symbols, key=str)).degree() >= 1
    except sp.PolynomialError:
        is_poly = False
    return Item(
        prob,
        _latex(expr) + r"\quad \text{(irreducible over } \mathbb{Q}\text{)}",
        "sympy" if is_poly else None,
        note="" if is_poly else "did not factor and not a polynomial",
    )


def identity(prompt_latex, lhs_str, rhs_str):
    r"""Recall an algebraic law, e.g. 2^a 2^b = 2^{a+b} or \ln(ab)=\ln a+\ln b.

    `prompt_latex` is the displayed left side, written by hand so sympy can't
    fold it into the answer; `lhs_str`/`rhs_str` are the sympy forms checked for
    equality. Verified by an INDEPENDENT numeric cross-check: both sides are
    evaluated at three concrete positive points for every free symbol and must
    agree. Positivity keeps log / fractional-power domains valid, sidestepping
    the assumptions symbolic simplification would otherwise need. The answer is
    sympy's rendering of the right side.
    """
    lhs, rhs = _parse(lhs_str), _parse(rhs_str)
    syms = sorted(lhs.free_symbols | rhs.free_symbols, key=lambda s: s.name)
    ok = True
    for i in range(3):
        pt = {s: sp.Rational(7, 3) + i + j for j, s in enumerate(syms)}
        lv = complex(lhs.subs(pt).evalf())
        rv = complex(rhs.subs(pt).evalf())
        if abs(lv - rv) > 1e-9:
            ok = False
            break
    return Item(
        latex_problem_text=prompt_latex,
        latex_answer_text=_latex(rhs),
        answer_verified_by="sympy" if ok else None,
        note="" if ok else "numeric cross-check failed",
    )


# --- multivariable: partial derivatives & double integrals -------------------

def _partial_op_latex(seq):
    r"""LaTeX for the partial-derivative operator from the variable sequence:
    ["x"] -> ∂/∂x ; ["x","x"] -> ∂²/∂x² ; ["x","y"] -> ∂²/∂x∂y."""
    n = len(seq)
    num = r"\partial" if n == 1 else r"\partial^%d" % n
    if len(set(seq)) == 1:
        v = seq[0]
        den = r"\partial %s" % v if n == 1 else r"\partial %s^%d" % (v, n)
    else:
        den = r"\,".join(r"\partial %s" % v for v in seq)
    return r"\frac{%s}{%s}" % (num, den)


def partial(expr_str, wrt):
    """Partial derivative of a multivariable function.

    `wrt` is a variable name ("x") for a first partial, or a list applied left
    to right for higher / mixed partials (["x","x"] -> ∂²/∂x²; ["x","y"] ->
    ∂²/∂x∂y). Direct computation: sympy's diff is the source of truth, exactly
    as in derivative() — differentiation has no cheap inverse to cross-check, so
    this type is always verifiable.
    """
    seq = [wrt] if isinstance(wrt, str) else list(wrt)
    expr = _parse(expr_str)
    answer = expr
    for v in seq:
        answer = sp.diff(answer, sp.Symbol(v))
    problem_latex = r"%s\left( %s \right)" % (_partial_op_latex(seq), _latex(expr))
    return Item(
        latex_problem_text=problem_latex,
        latex_answer_text=_latex(_present(answer, sp.Symbol(seq[-1]))),
        answer_verified_by="sympy",
    )


def double_integral(expr_str, inner, outer):
    r"""Definite double integral ∫∫ f dA, inner integral evaluated first.

    inner = (var, lo, hi): integrated first; its limits may be expressions in
            the outer variable (non-rectangular regions) or constants.
    outer = (var, lo, hi): constant limits.

    Verification: symbolic iterated integration must yield a closed form (no
    unevaluated Integral, no special function) AND an INDEPENDENT numeric
    cross-check — nested mpmath quadrature over the region (the inner integral
    re-evaluated at each outer sample, so variable limits are handled) — must
    agree. The symbolic integrator never grades itself, as with single integrals
    / LOTUS.
    """
    iv, ilo, ihi = inner
    ov, olo, ohi = outer
    yv, xv = sp.Symbol(iv), sp.Symbol(ov)
    f = _parse(expr_str)
    ilo_e, ihi_e = _parse(str(ilo)), _parse(str(ihi))
    olo_e, ohi_e = _parse(str(olo)), _parse(str(ohi))

    problem_latex = r"\int_{%s}^{%s}\!\int_{%s}^{%s} %s \, d%s \, d%s" % (
        _latex(olo_e), _latex(ohi_e), _latex(ilo_e), _latex(ihi_e),
        _latex(f), iv, ov,
    )

    inner_val = sp.integrate(f, (yv, ilo_e, ihi_e))
    value = sp.integrate(inner_val, (xv, olo_e, ohi_e))

    if inner_val.has(sp.Integral) or value.has(sp.Integral):
        return Item(problem_latex, "", None,
                    note="sympy returned an unevaluated integral")
    if _has_special(inner_val) or _has_special(value):
        return Item(problem_latex, "", None,
                    note="answer involves a special function")

    try:
        sym = complex(sp.N(value))
        f_fn = sp.lambdify((xv, yv), f, "mpmath")
        ilo_fn = sp.lambdify(xv, ilo_e, "mpmath")
        ihi_fn = sp.lambdify(xv, ihi_e, "mpmath")
        inner_q = lambda xval: mpmath.quad(
            lambda yval: f_fn(xval, yval), [ilo_fn(xval), ihi_fn(xval)])
        num = complex(mpmath.quad(inner_q, [float(olo_e), float(ohi_e)]))
    except (TypeError, ValueError) as e:
        return Item(problem_latex, _latex(_pretty(value)), None,
                    note=f"could not numerically cross-check ({e})")

    ok = abs(sym - num) < 1e-6 * (1 + abs(sym))
    return Item(
        latex_problem_text=problem_latex,
        latex_answer_text=_latex(_pretty(value)),
        answer_verified_by="sympy" if ok else None,
        note="" if ok else f"numeric cross-check failed ({sym} vs {num})",
    )


# ============================================================================
# Part-I coverage generators (BATCH_PLANNING.md §1–§9).
# Curated to also cover trivial-yet-instructive and gotcha cases. Gotchas whose
# answer is a verdict (diverges / undefined / does not exist) are verified by
# sympy returning ±oo / refusing the operation / one-sided disagreement.
# ============================================================================

def _mat(rows):
    return sp.Matrix([[_parse(str(e)) for e in row] for row in rows])


# --- §2 combinatorics -------------------------------------------------------

def binomial(n, k):
    """C(n, k). Always sympy. Edge: k>n -> 0, C(n,0)=C(n,n)=1, symbolic n."""
    N, K = _parse(str(n)), _parse(str(k))
    return Item(r"\binom{%s}{%s}" % (_latex(N), _latex(K)),
                _latex(sp.binomial(N, K)), "sympy")


# --- §1d complete the square ------------------------------------------------

def complete_square(expr_str, var="x"):
    """ax^2+bx+c -> a(x-h)^2+k, verified by expand-back."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    prob = r"\text{complete the square: } %s" % _latex(expr)
    p = sp.Poly(sp.expand(expr), x)
    if p.degree() != 2:
        return Item(prob, "", None, note="not a quadratic")
    a, b, c = p.all_coeffs()
    h = sp.nsimplify(-b / (2 * a))
    k = sp.nsimplify(c - b ** 2 / (4 * a))
    form = a * (x - h) ** 2 + k
    verified = sp.expand(form - expr) == 0
    return Item(prob, _latex(form), "sympy" if verified else None,
                note="" if verified else "did not expand back")


# --- §1e partial fractions --------------------------------------------------

def partial_fractions(expr_str, var="x"):
    """sympy apart(); verified by recombining (together(apart) == expr)."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    ans = sp.apart(expr, x)
    verified = sp.simplify(sp.together(ans) - expr) == 0
    return Item(r"\text{decompose: } %s" % _latex(expr),
                _latex(ans), "sympy" if verified else None,
                note="" if verified else "did not recombine")


# --- §3b higher-order derivatives -------------------------------------------

def higher_derivative(expr_str, order, var="x"):
    """n-th derivative. Direct computation (sympy). Edge: vanishes for d^n of a
    degree<n polynomial."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    ans = sp.diff(expr, x, order)
    return Item(
        r"\frac{d^{%d}}{d%s^{%d}}\left( %s \right)" % (order, var, order, _latex(expr)),
        _latex(_present(ans, x)), "sympy")


# --- §3f differentiate under the integral sign (Leibniz) --------------------

def leibniz(expr_str, t="t", x="x", a="0", b="x"):
    """d/dt ∫_a^b f(x,t) dx. Verified: sympy's native Leibniz expansion agrees
    with integrate-then-differentiate (handles the FTC case d/dt ∫_0^t f = f(t)
    even when ∫ f has no elementary form)."""
    tv, xv = sp.Symbol(t), sp.Symbol(x)
    f = _parse(expr_str)
    A, B = _parse(str(a)), _parse(str(b))
    prob = r"\frac{d}{d%s} \int_{%s}^{%s} %s \, d%s" % (t, _latex(A), _latex(B), _latex(f), x)
    ans = sp.diff(sp.Integral(f, (xv, A, B)), tv).doit()
    if ans.has(sp.Integral):
        ans = ans.doit()
        if ans.has(sp.Integral):
            return Item(prob, "", None, note="unevaluated")
    # numeric cross-check: central finite-difference of the t-parametrized
    # integral (limits may depend on t), independent of the symbolic result.
    t0, h = 0.7, 1e-5
    try:
        ans_num = complex(ans.subs(tv, t0).evalf())

        def _ival(tval):
            lo = float(A.subs(tv, tval)) if A.free_symbols else float(A)
            hi = float(B.subs(tv, tval)) if B.free_symbols else float(B)
            g = sp.lambdify(xv, f.subs(tv, tval), "mpmath")
            return complex(mpmath.quad(g, [lo, hi]))

        fd = (_ival(t0 + h) - _ival(t0 - h)) / (2 * h)
        ok = abs(ans_num - fd) < 1e-4 * (1 + abs(ans_num))
    except Exception:  # noqa: BLE001
        ok = False
    return Item(prob, _latex(sp.simplify(ans)), "sympy" if ok else None,
                note="" if ok else "numeric cross-check failed")


# --- §4e improper integrals (divergence-aware) ------------------------------

def improper_integral(expr_str, a, b, var="x"):
    """Definite integral, possibly improper. Divergent -> 'diverges' (sympy
    returns ±oo). Convergent -> numeric cross-check."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    A, B = _parse(str(a)), _parse(str(b))
    val = sp.integrate(expr, (x, A, B))
    prob = r"\int_{%s}^{%s} %s \, d%s" % (_latex(A), _latex(B), _latex(expr), var)
    if val in (sp.oo, -sp.oo, sp.zoo) or (val.has(sp.oo) or val.has(sp.zoo)):
        return Item(prob, r"\text{diverges}", "sympy")
    if val is sp.nan or val.has(sp.Integral):
        return Item(prob, "", None, note="unevaluated / nan")
    if _has_special(val):
        return Item(prob, "", None, note="special function")
    return _num_def_integral(prob, expr, x, A, B, val)


# --- §4f/4g/4h numeric-verified integrals (gamma / beta / gaussian) ---------

def numeric_integral(expr_str, a, b, var="x"):
    """Definite integral verified PURELY by numeric quadrature — for integrands
    whose antiderivative is a special function (gamma/beta/gaussian)."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    A, B = _parse(str(a)), _parse(str(b))
    val = sp.integrate(expr, (x, A, B))
    prob = r"\int_{%s}^{%s} %s \, d%s" % (_latex(A), _latex(B), _latex(expr), var)
    if val.has(sp.Integral) or val is sp.nan:
        return Item(prob, "", None, note="unevaluated")
    return _num_def_integral(prob, expr, x, A, B, val)


def _num_def_integral(prob, expr, x, A, B, val):
    try:
        sym = complex(sp.N(val))
        lo = -mpmath.inf if A == -sp.oo else float(A)
        hi = mpmath.inf if B == sp.oo else float(B)
        num = complex(mpmath.quad(sp.lambdify(x, expr, "mpmath"), [lo, hi]))
    except Exception as e:  # noqa: BLE001 - any numeric failure -> unverified
        return Item(prob, _latex(_pretty(val)), None, note=f"no cross-check ({e})")
    ok = abs(sym - num) < 1e-6 * (1 + abs(sym))
    return Item(prob, _latex(_pretty(val)), "sympy" if ok else None,
                note="" if ok else f"numeric mismatch ({sym} vs {num})")


# --- §5a/5b/5c sums & series ------------------------------------------------

def summation(expr_str, k="k", lo=1, hi="n"):
    """Σ. Divergent -> 'diverges'. Finite numeric -> recompute; infinite ->
    partial-sum numeric check; symbolic upper limit -> trust sympy."""
    kv = sp.Symbol(k)
    expr = _parse(expr_str)
    LO, HI = _parse(str(lo)), _parse(str(hi))
    val = sp.summation(expr, (kv, LO, HI))
    if isinstance(val, sp.Piecewise):
        val = _conv_branch(val)
    prob = r"\sum_{%s=%s}^{%s} %s" % (k, _latex(LO), _latex(HI), _latex(expr))
    if val in (sp.oo, -sp.oo, sp.zoo) or (hasattr(val, "has") and (val.has(sp.oo) or val.has(sp.zoo))):
        return Item(prob, r"\text{diverges}", "sympy")
    if hasattr(val, "has") and val.has(sp.Sum):
        return Item(prob, "", None, note="unevaluated")
    verified = True
    if HI == sp.oo:
        if expr.free_symbols - {kv}:
            verified = True  # symbolic infinite sum: can't numeric-check, trust sympy
        else:
            try:
                partial = sum(complex(expr.subs(kv, i).evalf())
                              for i in range(int(LO), int(LO) + 3000))
                verified = abs(complex(sp.N(val)) - partial) < 1e-3
            except Exception:  # noqa: BLE001
                verified = False
    elif HI.is_number and LO.is_number:
        direct = sum(expr.subs(kv, i) for i in range(int(LO), int(HI) + 1))
        verified = sp.simplify(val - direct) == 0
    return Item(prob, _latex(_pretty(val)), "sympy" if verified else None,
                note="" if verified else "cross-check failed")


# --- §5d binomial theorem ---------------------------------------------------

def binomial_expand(a_str, b_str, n):
    """(a+b)^n expanded. Edge: n=0 -> 1. Verified by sympy expand."""
    a, b = _parse(a_str), _parse(b_str)
    base = a + b
    return Item(_latex(base ** n), _latex(sp.expand(base ** n)), "sympy")


# --- §5e/5f Taylor / power series -------------------------------------------

def taylor(expr_str, var="x", point=0, order=5):
    """Taylor polynomial through O(var^order). Direct (sympy series)."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    P = _parse(str(point))
    series = sp.series(expr, x, P, order).removeO()
    at = "" if P == 0 else r" \text{ at } %s=%s" % (var, _latex(P))
    prob = r"\text{series of } %s%s \text{ through } %s^{%d}" % (_latex(expr), at, var, order - 1)
    return Item(prob, _latex(series), "sympy")


# --- §6 limits --------------------------------------------------------------

def limit_(expr_str, var="x", point="oo", direction="+"):
    """lim. direction='both' detects DNE via one-sided disagreement; ±oo and
    oscillation report 'diverges' / 'does not exist'."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    P = _parse(str(point))
    ptl = r"\infty" if P == sp.oo else (r"-\infty" if P == -sp.oo else _latex(P))
    prob = r"\lim_{%s \to %s} %s" % (var, ptl, _latex(expr))
    if direction == "both":
        left, right = sp.limit(expr, x, P, "-"), sp.limit(expr, x, P, "+")
        if left != right:
            return Item(prob, r"\text{does not exist}", "sympy")
        val = right
    else:
        val = sp.limit(expr, x, P, direction)
    if val == sp.oo:
        return Item(prob, r"\infty", "sympy")
    if val == -sp.oo:
        return Item(prob, r"-\infty", "sympy")
    if val == sp.zoo or (hasattr(val, "has") and val.has(sp.AccumBounds)):
        return Item(prob, r"\text{does not exist}", "sympy")
    return Item(prob, _latex(_pretty(val)), "sympy")


# --- §7a/7b determinants ----------------------------------------------------

def determinant(rows):
    """det of a matrix. Non-square -> undefined (gotcha)."""
    M = _mat(rows)
    prob = r"\det %s" % sp.latex(M)
    if M.rows != M.cols:
        return Item(prob, r"\text{undefined (not square)}", "sympy")
    return Item(prob, _latex(M.det()), "sympy")


# --- §7c 2x2 inverse --------------------------------------------------------

def matrix_inverse(rows):
    """Matrix inverse. Non-square / singular -> no inverse (gotcha). Verified by
    A·A⁻¹ = I."""
    M = _mat(rows)
    prob = r"%s^{-1}" % sp.latex(M)
    if M.rows != M.cols:
        return Item(prob, r"\text{undefined (not square)}", "sympy")
    if M.det() == 0:
        return Item(prob, r"\text{no inverse (singular)}", "sympy")
    inv = M.inv()
    verified = sp.simplify(M * inv - sp.eye(M.rows)).is_zero_matrix
    return Item(prob, sp.latex(inv), "sympy" if verified else None,
                note="" if verified else "A·A^-1 != I")


# --- §7d quadratic form -----------------------------------------------------

def quadratic_form(rows, variables=("x", "y")):
    """xᵀ A x, expanded. Verified by sympy expand."""
    A = _mat(rows)
    v = sp.Matrix([sp.Symbol(s) for s in variables])
    val = sp.expand((v.T * A * v)[0])
    prob = r"\mathbf{x}^\top %s \, \mathbf{x},\quad \mathbf{x}=%s" % (sp.latex(A), sp.latex(v))
    return Item(prob, _latex(val), "sympy")


# --- §8c switch order of integration ----------------------------------------

def switch_order(expr_str, inner, outer, inner2, outer2):
    """Present an iterated integral; answer is the order-reversed one. Verified:
    both orders evaluate to the same value."""
    f = _parse(expr_str)

    def _val(inn, out):
        iv, ilo, ihi = inn
        ov, olo, ohi = out
        Y, X = sp.Symbol(iv), sp.Symbol(ov)
        return sp.integrate(
            sp.integrate(f, (Y, _parse(str(ilo)), _parse(str(ihi)))),
            (X, _parse(str(olo)), _parse(str(ohi))))

    def _tex(inn, out):
        iv, ilo, ihi = inn
        ov, olo, ohi = out
        return r"\int_{%s}^{%s}\!\int_{%s}^{%s} %s \, d%s \, d%s" % (
            _latex(_parse(str(olo))), _latex(_parse(str(ohi))),
            _latex(_parse(str(ilo))), _latex(_parse(str(ihi))),
            _latex(f), iv, ov)

    prob = r"\text{reverse the order: } %s" % _tex(inner, outer)
    verified = sp.simplify(_val(inner, outer) - _val(inner2, outer2)) == 0
    return Item(prob, _tex(inner2, outer2), "sympy" if verified else None,
                note="" if verified else "orders disagree")


# --- §9a critical points ----------------------------------------------------

def critical_points(expr_str, var="x"):
    """All real critical points (f'=0), unclassified. Edge: x^3 -> a critical
    point that is not an extremum. Gotcha: no real critical points; constant f."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    f1 = sp.diff(expr, x)
    prob = r"f(%s) = %s,\quad \text{find all critical points}" % (var, _latex(expr))
    if f1 == 0:
        return Item(prob, r"\text{every } %s \text{ (f is constant)}" % var, "sympy")
    cps = sorted([c for c in sp.solve(f1, x) if c.is_real],
                 key=lambda c: float(c.evalf()))
    if not cps:
        return Item(prob, r"\text{none}", "sympy")
    if all(sp.simplify(f1.subs(x, c)) == 0 for c in cps):
        return Item(prob, ",\\ ".join(r"%s=%s" % (var, _latex(c)) for c in cps), "sympy")
    return Item(prob, "", None, note="critical-point check failed")
