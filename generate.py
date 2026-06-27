"""Staging for Lightspeed: dedup + write generated problems into SQLite.

The problem-type generators (derivative, integral, definite_integral,
expectation, variance, plus the Dist/Item dataclasses) live in problem_types.py
and are re-exported here, so a session can still do everything from one import:

    from generate import derivative, integral, stage
    items = [
        derivative("x**3 * sin(x)"),
        integral("x * exp(x)"),
        definite_integral("x/(x**2+1)", 0, 1),
    ]
    stage("chain-rule derivatives and basic integrals", items, tags=["derivatives"])

This module owns the DB-facing half: dedup against the whole bank (regardless of
status, so rejected problems never resurface), refusal to stage any unverified
item, and the staged-batch write. Correctness lives in problem_types.py — golden
rule #1: answers are computed AND independently verified, never LLM-guessed. See
TYPES.md for the presentation style and verification method of each type.
"""

import db
from problem_types import (  # re-exported for one-import session ergonomics
    Dist,
    Item,
    definite_integral,
    derivative,
    expectation,
    integral,
    variance,
)

__all__ = [
    "Dist",
    "Item",
    "definite_integral",
    "derivative",
    "expectation",
    "integral",
    "variance",
    "stage",
]


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
