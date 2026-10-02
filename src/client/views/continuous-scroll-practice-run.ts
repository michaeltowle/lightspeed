import { peekAtManeuvers, recordProblemWorked, revealAnswers, skipAttempt } from "../api";
import { h } from "../lib/dom";
import { renderMathHtml } from "../lib/katex-boot";
import { renderManeuverTable } from "../lib/maneuver-table";
import { refreshTrophyWall } from "./trophy-wall";
import { answerRow } from "./answers";
import type { ServedProblem, View } from "../types";

type Speed = "slow" | "fast";

/**
 * The whole run on one page, worked down like an exam paper. Mike works on
 * paper, so this is still display-only: no answer input.
 *
 * The set is timed, not the problems in it: the clock runs from the run
 * opening to done. With every problem on screen there is no moment a single
 * problem starts, so a per-problem time would be a guess.
 *
 * Grading here is optional, and open on any problem at any time: its answer
 * is revealed and graded where it sits. Whatever is neither graded nor skipped
 * by done is revealed on the answers page as before.
 */
export function renderContinuousScrollPracticeRun(
  root: HTMLElement,
  runId: number,
  problems: ServedProblem[],
  go: (view: View) => void,
): void {
  function problemItem(problem: ServedProblem, index: number): HTMLElement {
    let skipped = false;
    let grading = false;
    let neededHelp = false;
    let workingSpeed: Speed | null = null;
    let busy = false;

    const el = h("li", {});
    const statusEl = h("span", { class: "continuous-scroll-practice-run-status" });
    const fail = (err: unknown) => {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.classList.add("err");
    };

    const bodyEl = h("div", { class: "problem-body" });
    renderMathHtml(bodyEl, problem.statement_html);

    const helpPanelEl = h("div", {});
    const gradePanelEl = h("div", {});

    // Saved as it is said, since there is no moving on to say it before.
    // Neither starts lit; whatever is still unsaid at done is saved as mid.
    const record = () => recordProblemWorked(runId, index, neededHelp, workingSpeed);
    const speedEls = (["slow", "fast"] as const).map((speed) => {
      const button = h("button", { type: "button", class: "speed-report-button" }, [speed]);
      button.addEventListener("click", () => {
        workingSpeed = workingSpeed === speed ? null : speed;
        speedEls.forEach((each, i) =>
          each.classList.toggle("is-on", workingSpeed === (["slow", "fast"] as const)[i]),
        );
        void record().catch(fail);
      });
      return button;
    });

    // A problem with no table yet has no help to give.
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
        const [{ maneuvers }] = await Promise.all([peekAtManeuvers(problem.id), record()]);
        helpPanelEl.replaceChildren(renderManeuverTable(maneuvers, { mode: "help" }));
      } catch (err) {
        fail(err);
        helpEl.disabled = false;
      }
    });

    // Passed over rather than worked: off the wall and out of the accuracy.
    const skipEl = h("button", { type: "button" }, ["skip"]);
    skipEl.addEventListener("click", async () => {
      if (busy || problem.problem_attempt_id === null) return;
      busy = true;
      try {
        await skipAttempt(problem.problem_attempt_id);
        skipped = true;
        helpPanelEl.replaceChildren();
        paint();
      } catch (err) {
        fail(err);
      } finally {
        busy = false;
      }
    });

    const gradeEl = h("button", { type: "button", class: "grade" }, ["grade"]);
    async function openGrading(): Promise<void> {
      if (problem.problem_attempt_id === null) return;
      gradeEl.disabled = true;
      try {
        const { rows, maneuvers, marks } = await revealAnswers(runId, problem.problem_attempt_id);
        const row = rows[0];
        if (!row) throw new Error("no such attempt");
        grading = true;
        // The covered table has nothing left to hide.
        helpPanelEl.replaceChildren();
        gradePanelEl.replaceChildren(
          answerRow(row, maneuvers, marks, () => void openGrading(), {
            onOutcome: () => void refreshTrophyWall(),
          }),
        );
        paint();
      } catch (err) {
        fail(err);
      } finally {
        gradeEl.disabled = false;
      }
    }
    gradeEl.addEventListener("click", () => void openGrading());

    function paint(): void {
      el.classList.toggle("is-skipped", skipped);
      // Grading reveals the answer, so help and skip have nothing left to do.
      helpEl.hidden = skipped || grading;
      skipEl.hidden = skipped || grading;
      gradeEl.hidden = skipped || grading;
      for (const each of speedEls) each.hidden = skipped;
      statusEl.textContent = skipped ? "skipped" : "";
    }

    el.append(
      h("div", { class: "continuous-scroll-practice-run-number" }, [
        `${index + 1}.`,
        // The number off the page, which is what is on the paper beside you.
        ...(problem.textbook_problem_number_label
          ? [
              h("span", { class: "textbook-problem-number-label" }, [
                problem.textbook_problem_number_label,
              ]),
            ]
          : []),
      ]),
      h("div", { class: "continuous-scroll-practice-run-content" }, [
        bodyEl,
        h("div", { class: "row continuous-scroll-practice-run-controls" }, [
          ...speedEls,
          helpEl,
          skipEl,
          gradeEl,
          statusEl,
        ]),
        helpPanelEl,
        gradePanelEl,
      ]),
    );
    paint();
    return el;
  }

  // Pinned in the corner, so the end of the set is never a scroll away.
  const doneEl = h("button", { type: "button", class: "continuous-scroll-practice-run-done" }, [
    "done",
  ]);
  doneEl.addEventListener("click", () => go({ name: "answers", runId }));

  root.replaceChildren(
    h("div", { class: "meta" }, [`${problems.length} problems`]),
    h("ol", { class: "continuous-scroll-practice-run" }, problems.map(problemItem)),
    doneEl,
  );
}
