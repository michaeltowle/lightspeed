"""Generation + staging for Lightspeed.

Used from a Claude Code session. Claude picks the problems; sympy computes and
verifies every answer; verified problems are staged for approval via stage().

CORRECTNESS RULE: an answer is marked verified ONLY when sympy confirms it.
For integrals this is done by differentiating the result and checking it equals
the integrand (certain even when computing the integral is hard). If sympy
cannot confirm, answer_verified_by is None and the item is excluded from staging
(and excluded from quizzes by default downstream).

Typical session usage:

    from generate import derivative, integral, stage
    items = [
        derivative("x**3 * sin(x)"),
        derivative("exp(2*x) / (x**2 + 1)"),
        integral("x * exp(x)"),
        integral("1 / (x**2 + 1)"),
    ]
    stage("chain-rule derivatives and basic integrals", items)
"""

from dataclasses import dataclass

import sympy as sp
from sympy.parsing.sympy_parser import (
    parse_expr,
    standard_transformations,
    implicit_multiplication_application,
    convert_xor,
)

import db

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


def derivative(expr_str, var="x"):
    """d/dx of expr. Derivatives are always sympy-verifiable."""
    x = sp.Symbol(var)
    expr = _parse(expr_str)
    answer = sp.diff(expr, x)
    problem_latex = r"\frac{d}{d%s}\left(%s\right)" % (var, sp.latex(expr))
    return Item(
        latex_problem_text=problem_latex,
        latex_answer_text=sp.latex(sp.simplify(answer)),
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

    problem_latex = r"\int %s \, d%s" % (sp.latex(expr), var)
    answer_latex = sp.latex(answer) + " + C"
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
        sp.latex(A), sp.latex(B), sp.latex(expr), var
    )
    answer_latex = sp.latex(sp.simplify(value))
    return Item(
        latex_problem_text=problem_latex,
        latex_answer_text=answer_latex,
        answer_verified_by="sympy" if verified else None,
        note=note,
    )


def _report_skipped(skipped):
    if skipped:
        print(f"  skipped {len(skipped)} duplicate(s):")
        for text, why in skipped:
            print(f"    {text}  -- {why}")


def _report_unverified(items):
    if items:
        print(f"  skipped {len(items)} unverified (sympy could not confirm the answer):")
        for it in items:
            print(f"    {it.latex_problem_text}  -- {it.note}")


def stage(prompt, items, tags=None, problem_source=None, answer_source=None):
    """Persist a batch of generated Items as 'staged' problems for approval.

    tags: list of tag names applied to EVERY problem in the batch (tags are
    batch-level; Claude assigns them at generation, the user never picks them).
    Returns (batch_id, [problem_ids]). Prints a summary including any items
    that could not be verified, so they are never silently treated as graded.
    """
    tags = tags or []
    db.init_db()
    conn = db.connect()
    try:
        existing = db.existing_problem_texts(conn)  # dedup vs. whole bank
        seen = set()
        fresh, skipped, unverified_filtered = [], [], []
        for it in items:
            text = it.latex_problem_text
            if text in existing:
                skipped.append((text, f"already in db ({existing[text]})"))
            elif text in seen:
                skipped.append((text, "duplicate within this batch"))
            elif it.answer_verified_by is None:
                unverified_filtered.append(it)
            else:
                seen.add(text)
                fresh.append(it)

        if not fresh:
            print(f"Nothing staged for {prompt!r}: all {len(items)} skipped.")
            _report_skipped(skipped)
            _report_unverified(unverified_filtered)
            return None, []

        batch_id = db.create_batch(conn, prompt)
        ids = []
        for it in fresh:
            p = {
                "latex_problem_text": it.latex_problem_text,
                "latex_answer_text": it.latex_answer_text,
                "answer_verified_by": it.answer_verified_by,
                "problem_source": problem_source or it.problem_source,
                "answer_source": answer_source or it.answer_source,
            }
            pid = db.insert_staged_problem(conn, batch_id, p)
            ids.append(pid)
        tag_ids = [db.get_or_create_tag(conn, t) for t in tags]
        db.apply_tags_to_batch(conn, batch_id, tag_ids)
        conn.commit()
    finally:
        conn.close()

    print(f"Staged batch {batch_id}: {len(ids)} problems for prompt {prompt!r}")
    if tags:
        print(f"  tags: {', '.join(tags)}")
    _report_skipped(skipped)
    _report_unverified(unverified_filtered)
    return batch_id, ids
