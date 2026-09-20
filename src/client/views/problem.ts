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
      disabled: !problem.broken_into_maneuvers_at,
      title: problem.broken_into_maneuvers_at
        ? "show the method, with every result covered"
        : "this problem has not been broken into maneuvers yet",
    },
    [problem.broken_into_maneuvers_at ? "help" : "no table yet"],
  );

  helpEl.addEventListener("click", async () => {
    helpEl.disabled = true;
    neededHelp = true;
    try {
      const { maneuvers } = await peekAtManeuvers(problem.id);
      helpPanelEl.replaceChildren(
        renderManeuverTable(maneuvers, { mode: "help", onDrill: openDrillTab }),
      );
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.className = "err";
      helpEl.disabled = false;
    }
  });

  /**
   * The step, drilled in a tab of its own. A new tab rather than a navigation
   * on purpose: the run stays exactly where it is, so dropping down to
   * practise a move costs nothing but the tab switch back.
   */
  function openDrillTab(maneuver: { id: number }): void {
    window.open(`/?tmpname_drill=${maneuver.id}`, "_blank", "noopener");
  }

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
      await recordProblemWorked(runId, index, Math.round(elapsed), neededHelp);
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
