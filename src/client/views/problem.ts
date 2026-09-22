import { peekAtManeuvers, recordProblemWorked, skipAttempt } from "../api";
import { h } from "../lib/dom";
import { renderMathHtml } from "../lib/katex-boot";
import { renderManeuverTable } from "../lib/maneuver-table";
import type { ServedProblem, View } from "../types";

/**
 * One problem at a time, forward only. Because there is no back navigation each
 * problem has exactly one interval, so timing is a single start/stop -- no
 * accumulation across visits.
 *
 * Mike works on paper, so this view is display-only: no answer input. What it
 * does offer is help -- the maneuver table with every result covered, each
 * uncoverable on its own. Taking it is recorded on the attempt rather than
 * disqualifying it: an assisted solve is still a solve, it just says so.
 */
export function renderProblem(
  root: HTMLElement,
  runId: number,
  problems: ServedProblem[],
  index: number,
  go: (view: View) => void,
): void {
  const problem = problems[index];
  const isLast = index === problems.length - 1;
  const startedAt = performance.now();
  let advancing = false;
  let neededHelp = false;

  const bodyEl = h("div", { class: "problem-body" });
  renderMathHtml(bodyEl, problem.statement_html);

  const statusEl = h("div", { id: "out" });
  const helpPanelEl = h("div", {});

  // A problem with no table yet has no help to give and no answer to reveal at
  // the end. Saying so here beats letting it surprise you on the answers page.
  const helpEl = h(
    "button",
    {
      type: "button",
      disabled: !problem.last_solved_by_llm_at,
      title: problem.last_solved_by_llm_at
        ? "show the method, with every result covered"
        : "this problem has not been solved yet",
    },
    [problem.last_solved_by_llm_at ? "help" : "no table yet"],
  );

  helpEl.addEventListener("click", async () => {
    helpEl.disabled = true;
    neededHelp = true;
    try {
      const { maneuvers } = await peekAtManeuvers(problem.id);
      helpPanelEl.replaceChildren(
        renderManeuverTable(maneuvers, { mode: "help" }),
      );
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.className = "err";
      helpEl.disabled = false;
    }
  });

  // How the working felt, said before moving on. Beside the clock and not
  // instead of it: elapsed_ms knows how long it took, which is a different fact
  // from whether it felt laboured.
  //
  // Starts on mid, because mid is what most working is and the column was
  // coming back empty -- an unremarkable problem gives you no reason to reach
  // for the row, so the honest answer went unsaid. Pre-lighting it makes slow
  // and fast the only things worth a click, and pressing mid again still takes
  // the answer back off.
  let workingSpeed: "slow" | "mid" | "fast" | null = "mid";
  const speedEls = (["slow", "mid", "fast"] as const).map((speed) =>
    h(
      "button",
      {
        type: "button",
        class: speed === workingSpeed ? "speed-report-button is-on" : "speed-report-button",
      },
      [speed],
    ),
  );
  speedEls.forEach((el, i) => {
    const speed = (["slow", "mid", "fast"] as const)[i];
    el.addEventListener("click", () => {
      // A second press on the lit one takes it back to having said nothing.
      workingSpeed = workingSpeed === speed ? null : speed;
      speedEls.forEach((each, j) =>
        each.classList.toggle("is-on", workingSpeed === (["slow", "mid", "fast"] as const)[j]),
      );
    });
  });

  function onward(): void {
    if (isLast) go({ name: "answers", runId });
    else go({ name: "problem", runId, problems, index: index + 1 });
  }

  /**
   * Passed over rather than worked. The attempt is marked skipped, which keeps
   * it off the wall and out of the accuracy, and no interval is recorded --
   * time spent deciding not to do a problem is not time spent on it.
   */
  async function skip(): Promise<void> {
    if (advancing) return;
    advancing = true;
    try {
      if (problem.problem_attempt_id !== null) {
        await skipAttempt(problem.problem_attempt_id);
      }
      onward();
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.className = "err";
      advancing = false;
    }
  }

  async function advance(): Promise<void> {
    if (advancing) return;
    advancing = true;
    const elapsed = performance.now() - startedAt;

    try {
      // The attempt row already exists -- every one in the run was written when
      // it opened -- so this fills in what the working produced. The outcome
      // stays null until the answers page, which is why nothing appears on the
      // wall yet.
      await recordProblemWorked(runId, index, Math.round(elapsed), neededHelp, workingSpeed);
      onward();
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.className = "err";
      advancing = false;
    }
  }

  root.replaceChildren(
    h("div", { class: "problem-meta" }, [
      // The number off the page leads, because that is what Mike is working
      // from on paper. The quiz position is kept back for the answers page.
      ...(problem.textbook_problem_number_label
        ? [
            h("span", { class: "textbook-problem-number-label" }, [
              problem.textbook_problem_number_label,
            ]),
            "  ·  ",
          ]
        : []),
      `${index + 1} of ${problems.length}`,
    ]),
    bodyEl,
    // Ahead of next, because it is a judgement about the working just done and
    // pressing next is what ends it.
    h("div", { class: "row speed-report-row" }, [
      h("span", { class: "speed-report-label" }, ["speed"]),
      ...speedEls,
    ]),
    h("div", { class: "row" }, [
      h("button", { type: "button", onclick: () => void advance() }, [
        isLast ? "next (finish)" : "next",
      ]),
      helpEl,
      h("button", { type: "button", onclick: () => void skip() }, ["skip"]),
    ]),
    helpPanelEl,
    statusEl,
  );
}
