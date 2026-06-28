"""Staging for Lightspeed: dedup + write generated problems into SQLite.

Typical session usage:

    from problem_types import derivative
    from generate import stage

    items = [derivative("x**3 * sin(x)"), derivative("exp(x)*cos(x)"), ...]
    stage("chain-rule derivatives", items, type="derivative")

Batches are MONOTYPE: one `type` per batch (a registered problem type from
problem_types.TYPES). The type — bound to its generator and canonical
instruction — is applied to every problem in the batch.

This module owns the DB-facing half: dedup against the whole bank (regardless of
status, so rejected problems never resurface), refusal to stage any unverified
item, and the staged-batch write. Correctness lives in problem_types.py — golden
rule #1: answers are computed AND independently verified, never LLM-guessed. See
TYPES.md for the presentation style and verification method of each type.
"""

import db
from problem_types import TYPES

_REGISTRY = {t.name: t for t in TYPES}


def _ident(it):
    """A short human identifier for an item in skip/unverified reports."""
    return it.expression_1 or it.formula_1 or it.instructions


def _report_skipped(skipped):
    if skipped:
        print(f"  skipped {len(skipped)} duplicate(s):")
        for it, why in skipped:
            print(f"    {_ident(it)}  -- {why}")


def _report_unverified(items):
    if items:
        print(f"  skipped {len(items)} unverified (sympy could not confirm the answer):")
        for it in items:
            print(f"    {_ident(it)}  -- {it.note}")


def stage(prompt, items, type, subtype=None, problem_source=None, answer_source=None):
    """Persist a batch of generated Items as 'staged' problems for approval.

    type: the single registered problem-type name applied to EVERY problem in
    the batch (batches are monotype). Must be in problem_types.TYPES.
    subtype: optional depth-1 label within the type (e.g. a method like
    "integration_by_parts"), applied to every problem in the batch. CHECK
    existing subtypes first (`db.subtypes_by_type`) so names don't drift.
    Items flagged with the gotcha() wrapper carry `gotcha = 1`. Returns
    (batch_id, [problem_ids]) and prints a summary including any items that
    could not be verified, so they are never silently treated as graded.
    """
    if type not in _REGISTRY:
        raise ValueError(
            f"unknown type {type!r}; valid types: {', '.join(sorted(_REGISTRY))}"
        )
    ptype = _REGISTRY[type]

    db.init_db()
    conn = db.connect()
    try:
        # keep the full type registry in the DB so /types lists every type
        db.seed_types(conn, [(t.name, t.generator, t.default_instruction) for t in TYPES])
        existing = db.existing_problem_keys(conn)  # dedup vs. whole bank
        seen = set()
        fresh, skipped, unverified_filtered = [], [], []
        for it in items:
            key = db.problem_dedup_key(getattr(it, f) for f in db.PROBLEM_FIELDS)
            if key in existing:
                skipped.append((it, f"already in db ({existing[key]})"))
            elif key in seen:
                skipped.append((it, "duplicate within this batch"))
            elif it.answer_verified_by is None:
                unverified_filtered.append(it)
            else:
                seen.add(key)
                fresh.append(it)

        if not fresh:
            print(f"Nothing staged for {prompt!r}: all {len(items)} skipped.")
            _report_skipped(skipped)
            _report_unverified(unverified_filtered)
            return None, []

        batch_id = db.create_batch(conn, prompt)
        ids = []
        for it in fresh:
            p = {f: getattr(it, f) for f in db.PROBLEM_FIELDS}
            # canonical instruction comes from the type registry (single source);
            # a generator that specialized its instruction keeps it.
            if not it.instructions_specialized:
                p["instructions"] = ptype.default_instruction
            p["answer"] = it.answer
            p["answer_verified_by"] = it.answer_verified_by
            p["problem_source"] = problem_source or it.problem_source
            p["answer_source"] = answer_source or it.answer_source
            p["gotcha"] = it.gotcha
            ids.append(db.insert_staged_problem(conn, batch_id, p))

        type_id = db.get_or_create_type(
            conn, ptype.name, ptype.generator, ptype.default_instruction
        )
        db.apply_type_to_batch(conn, batch_id, type_id)
        if subtype:
            subtype_id = db.get_or_create_subtype(conn, type_id, subtype)
            db.apply_subtype_to_batch(conn, batch_id, subtype_id)
        conn.commit()
    finally:
        conn.close()

    n_gotcha = sum(1 for it in fresh if it.gotcha)
    label = f"  type: {ptype.name}" + (f" / {subtype}" if subtype else "")
    print(f"Staged batch {batch_id}: {len(ids)} problems for prompt {prompt!r}")
    print(label + (f"  ({n_gotcha} gotcha)" if n_gotcha else ""))
    _report_skipped(skipped)
    _report_unverified(unverified_filtered)
    return batch_id, ids
