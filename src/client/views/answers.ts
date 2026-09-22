import {
  clearManeuverCredit,
  markForFurtherPractice,
  markManeuverCredit,
  revealAnswers,
  setWhyThisOneWentWrong,
} from "../api";
import { renderReSolveControls } from "../lib/re-solve";
import { formatElapsed, h } from "../lib/dom";
import { renderMathHtml } from "../lib/katex-boot";
import { renderManeuverTable } from "../lib/maneuver-table";
import type { ManeuverCredit } from "../lib/maneuver-table";
import { refreshTrophyWall } from "./trophy-wall";
import type {
  AnswerRow,
  AttemptOutcome,
  Maneuver,
  PerManeuverCreditMark,
  View,
} from "../types";


function answerRow(
  row: AnswerRow,
  maneuvers: Maneuver[],
  marks: PerManeuverCreditMark[],
  onReSolved: () => void,
): HTMLElement {
  const item = h("li", {});
  let marked = row.marked_for_further_practice === 1;
  let outcome: AttemptOutcome | null = row.outcome;

  // Credit is held here and pushed to the worker, so a cell repaints on the
  // click rather than after the round trip. The worker's answer then replaces
  // it wholesale, so the guess never outlives the fact it was standing in for.
  const credit = new Map<number, ManeuverCredit>();
  const takeMarks = (saved: PerManeuverCreditMark[]) => {
    credit.clear();
    for (const mark of saved) {
      credit.set(mark.maneuver_id, mark.got_it === 1 ? "got" : "missed");
    }
  };
  takeMarks(marks);

  // Marks go out one at a time. Marking the last row green fans out to every
  // row, and a second click landing in the middle of that fan-out used to let
  // an older answer arrive last -- leaving the readout reporting one moment and
  // the colours another.
  let settled: Promise<void> = Promise.resolve();

  const outcomeEl = h("span", { class: "outcome-readout" });
  const paintOutcome = () => {
    // A fraction, not a word. "partly right" said the same thing about one of
    // six as it did about five of six, which is the whole of what there was to
    // know. Unreduced: 3/6 is three steps of six, and halving it would throw
    // away the six.
    const got = [...credit.values()].filter((each) => each === "got").length;
    outcomeEl.replaceChildren(
      ...(outcome === "skipped"
        ? ["outcome: ", h("strong", {}, ["skipped"])]
        : outcome
          ? ["credit: ", h("strong", {}, [`${got}/${maneuvers.length}`])]
          : [`${maneuvers.length ? "grade the maneuvers above" : ""}`]),
    );
    item.classList.toggle("is-skipped", outcome === "skipped");
  };

  // Why it went wrong, in his own words, written once the marks have shown him
  // where it went. Saved on blur rather than per keystroke: it is a sentence
  // being composed, not a filter being dragged.
  const whyEl = h("textarea", {
    class: "why-it-went-wrong-box",
    rows: 1,
    placeholder: "why did this go wrong?",
  });
  whyEl.value = row.why_this_one_went_wrong;
  let savedWhy = row.why_this_one_went_wrong;
  whyEl.addEventListener("blur", () => {
    const next = whyEl.value.trim();
    if (next === savedWhy) return;
    savedWhy = next;
    void setWhyThisOneWentWrong(row.attempt_id, next).catch(() => {
      // Nothing saved, so the box should not claim otherwise.
      savedWhy = row.why_this_one_went_wrong;
      whyEl.value = row.why_this_one_went_wrong;
    });
  });

  const markBox = h("input", { type: "checkbox" });
  markBox.checked = marked;

  const paintMark = () => {
    markBox.checked = marked;
    item.classList.toggle("marked", marked);
  };

  async function setMarked(next: boolean): Promise<void> {
    if (next === marked) return;
    const previous = marked;
    marked = next;
    paintMark();
    try {
      await markForFurtherPractice(row.attempt_id, next);
    } catch {
      marked = previous;
      paintMark();
    }
  }

  const problemEl = h("div", { class: "problem-body" });
  renderMathHtml(problemEl, row.statement_html);

  // The answer stands alone and always visible -- checking paper against it is
  // the first thing done on this page. It is the last maneuver's result, so
  // there is no separately stated answer to drift out of step with the steps.
  const finalManeuver = maneuvers[maneuvers.length - 1];
  const answerEl = h("div", { class: "final-answer" });
  renderMathHtml(answerEl, finalManeuver ? finalManeuver.result_html : "—");

  const tableEl = maneuvers.length
    ? renderManeuverTable(maneuvers, {
        mode: "grade",
        creditOf: (m) => credit.get(m.id) ?? "unmarked",
        onCycle: (m, next) => {
          // The last maneuver is the final answer, so getting it is getting the
          // whole problem: marking that row green marks every row green rather
          // than asking for the same click eight times over. Only green, and
          // only from the last row -- missing the answer says nothing about
          // which step lost it, which is exactly what the other rows are for.
          const allRight = next === "got" && m.id === finalManeuver?.id;
          const marking = allRight ? maneuvers : [m];
          const before = new Map(credit);
          for (const each of marking) credit.set(each.id, next);

          settled = settled.then(async () => {
            try {
              // The rollup is computed server-side per mark, so the row that
              // decides the outcome goes last and its answer is the one kept.
              for (const each of marking.filter((one) => one.id !== m.id)) {
                await markManeuverCredit(row.attempt_id, each.id, true);
              }
              const result =
                next === "unmarked"
                  ? await clearManeuverCredit(row.attempt_id, m.id)
                  : await markManeuverCredit(row.attempt_id, m.id, next === "got");
              outcome = result.outcome;
              takeMarks(result.marks);
              paintOutcome();
              void refreshTrophyWall();
              // A missed step is almost always something to practise again, so
              // it ticks the box for you. Changing the grade afterwards does not
              // untick it -- dropping a problem from the next set stays a choice
              // you make, never one made for you.
              if (next === "missed") void setMarked(true);
            } catch {
              // Nothing saved, so nothing should show as saved. The colours go
              // back to where the click found them -- every row of them, since
              // the click had run ahead to change more than the one clicked.
              takeMarks(
                [...before].map(([maneuver_id, had]) => ({
                  problem_attempt_id: row.attempt_id,
                  maneuver_id,
                  got_it: had === "got" ? 1 : 0,
                })),
              );
            }
          });
          return settled;
        },
      })
    : h("div", { class: "bank-note" }, ["no maneuver table for this problem yet"]);

  // Two jobs, one button. A problem served before its table landed has nothing
  // to grade, and solving it here beats sending Mike back to the bank. A
  // problem that already has a table sometimes has a bad one -- the route the
  // model took is roundabout, or it worked something it should have left set up
  // -- and this is the page where that becomes obvious, with the solution in
  // front of you. The box beside it is where he says what to do instead.
  const { howEl, solveEl } = renderReSolveControls({
    problemId: row.problem_id,
    editablePerProblemInstructionsToLlm: row.editable_per_problem_instructions_to_llm,
    alreadySolved: maneuvers.length > 0,
    // Re-solving replaces the table, and the marks hang off the rows it
    // replaces -- so the grading on screen goes with it. Worth a question when
    // there is grading to lose, and worth none when there is not.
    mayProceed: () =>
      !credit.size ||
      confirm("Re-solving replaces the table. The marks on this attempt go with it. Carry on?"),
    onReSolved,
  });

  paintMark();
  paintOutcome();
  item.append(
    h("div", { class: "meta" }, [
      `#${row.ordinal + 1}`,
      ...(row.textbook_problem_number_label
        ? ["  ·  ", h("span", { class: "textbook-problem-number-label" }, [
            row.textbook_problem_number_label,
          ])]
        : []),
      "  ·  ",
      row.elapsed_ms === null ? "not worked" : formatElapsed(row.elapsed_ms),
      ...(row.needed_help_during_attempt === 1
        ? ["  ·  ", h("span", { class: "took-help" }, ["took help"])]
        : []),
    ]),
    problemEl,
    answerEl,
    tableEl,
    whyEl,
    howEl,
    h("div", { class: "acts" }, [
      solveEl,
      outcomeEl,
      h("label", { class: "mark" }, [markBox, "marked for further practice"]),
    ]),
  );
  markBox.addEventListener("change", () => void setMarked(markBox.checked));
  return item;
}

export async function renderAnswers(
  root: HTMLElement,
  runId: number,
  go: (view: View) => void,
): Promise<void> {
  root.replaceChildren(h("div", { id: "out" }, ["loading answers..."]));

  let rows: AnswerRow[];
  let maneuvers: Maneuver[];
  let marks: PerManeuverCreditMark[];
  try {
    ({ rows, maneuvers, marks } = await revealAnswers(runId));
  } catch (err) {
    root.replaceChildren(
      h("div", { id: "out", class: "err" }, [
        err instanceof Error ? err.message : String(err),
      ]),
    );
    return;
  }

  const maneuversOf = (problemId: number) =>
    maneuvers.filter((m) => m.math_practice_problem_id === problemId);
  const marksOf = (attemptId: number) =>
    marks.filter((m) => m.problem_attempt_id === attemptId);

  const worked = rows.filter((row) => row.elapsed_ms !== null);
  const total = worked.reduce((sum, row) => sum + (row.elapsed_ms ?? 0), 0);

  // Solving a problem from this page changes what there is to grade, so the
  // page is rebuilt from the worker rather than patched in place.
  const again = () => void renderAnswers(root, runId, go);

  root.replaceChildren(
    h("h1", {}, ["answers"]),
    h("div", { class: "meta" }, [
      `${rows.length} problems  ·  ${formatElapsed(total)} total`,
    ]),
    h(
      "ul",
      { id: "saved" },
      rows.map((row) => answerRow(row, maneuversOf(row.problem_id), marksOf(row.attempt_id), again)),
    ),
    h("div", { class: "row" }, [
      h("button", { type: "button", id: "go", onclick: () => go({ name: "bank" }) }, ["home"]),
    ]),
  );
}
