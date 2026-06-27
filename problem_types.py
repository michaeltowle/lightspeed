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

These functions are re-exported from generate.py, so a session can still do:

    from generate import derivative, integral, stage
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
