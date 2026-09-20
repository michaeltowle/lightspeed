import {
  breakIntoManeuvers,
  clearManeuverCredit,
  markForFurtherPractice,
  markManeuverCredit,
  revealAnswers,
} from "../api";
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

const OUTCOME_WORDS: Record<AttemptOutcome, string> = {
  right: "right",
  partial: "partly right",
  wrong: "wrong",
  skipped: "skipped",
};

function answerRow(
  row: AnswerRow,
  maneuvers: Maneuver[],
  marks: PerManeuverCreditMark[],
  onRebroken: () => void,
): HTMLElement {
  const item = h("li", {});
  let marked = row.marked_for_further_practice === 1;
  let outcome: AttemptOutcome | null = row.outcome;

  // Credit is held here and pushed to the worker, so a cell repaints on the
  // click rather than after the round trip.
  const credit = new Map<number, ManeuverCredit>();
  for (const mark of marks) {
    credit.set(mark.maneuver_id, mark.got_it === 1 ? "got" : "missed");
  }

  const outcomeEl = h("span", { class: "outcome-readout" });
  const paintOutcome = () => {
    outcomeEl.replaceChildren(
      ...(outcome
        ? ["outcome: ", h("strong", {}, [OUTCOME_WORDS[outcome]])]
        : [`${maneuvers.length ? "grade the maneuvers above" : ""}`]),
    );
    item.classList.toggle("is-skipped", outcome === "skipped");
  };

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
        // Where a missed maneuver is staring at you is the best place to be
        // offered practice at it.
        onDrill: (m) => {
          window.open(`/?drill=${m.id}`, "_blank", "noopener");
        },
        creditOf: (m) => credit.get(m.id) ?? "unmarked",
        onCycle: async (m, next) => {
          const before = new Map(credit);
          // The last maneuver is the final answer, so getting it is getting the
          // whole problem: marking that row green marks every row green rather
          // than asking for the same click eight times over. Only green, and
          // only from the last row -- missing the answer says nothing about
          // which step lost it, which is exactly what the other rows are for.
          const allRight = next === "got" && m.id === finalManeuver?.id;
          const marking = allRight ? maneuvers : [m];
          for (const each of marking) credit.set(each.id, next);

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
            paintOutcome();
            void refreshTrophyWall();
            // A missed step is almost always something to practise again, so it
            // ticks the box for you. Changing the grade afterwards does not
            // untick it -- dropping a problem from the next set stays a choice
            // you make, never one made for you.
            if (next === "missed") void setMarked(true);
          } catch {
            credit.clear();
            for (const [id, had] of before) credit.set(id, had);
          }
        },
      })
    : h("div", { class: "bank-note" }, ["no maneuver table for this problem yet"]);

  // A problem served before its table landed has nothing to grade. Breaking it
  // here beats sending Mike back to the bank to do it.
  const breakEl = h("button", { type: "button", class: "grade" }, ["break it into maneuvers"]);
  breakEl.addEventListener("click", async () => {
    breakEl.disabled = true;
    breakEl.textContent = "breaking...";
    try {
      await breakIntoManeuvers(row.problem_id);
      onRebroken();
    } catch (err) {
      breakEl.textContent = err instanceof Error ? err.message : String(err);
      breakEl.disabled = false;
    }
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
    h("div", { class: "acts" }, [
      ...(maneuvers.length ? [] : [breakEl]),
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

  // Breaking a problem down from this page changes what there is to grade, so
  // the page is rebuilt from the worker rather than patched in place.
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
