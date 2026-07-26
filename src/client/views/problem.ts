import { tmpnameRecordAttempt01 } from "../api";
import { h } from "../lib/dom";
import { tmpnameRenderMathHtml01 } from "../lib/katex-boot";
import { tmpnameRefreshTrophyWall01 } from "./trophy-wall";
import type { TmpnameProblem01, TmpnameView01 } from "../types";

/**
 * One problem at a time, forward only. Because there is no back navigation each
 * problem has exactly one interval, so timing is a single start/stop -- no
 * accumulation across visits.
 *
 * Mike works on paper, so this view is display-only: no answer input.
 */
export function tmpnameRenderProblem01(
  root: HTMLElement,
  runId: number,
  problems: TmpnameProblem01[],
  index: number,
  go: (view: TmpnameView01) => void,
): void {
  const problem = problems[index];
  const isLast = index === problems.length - 1;
  const startedAt = performance.now();
  let advancing = false;

  const bodyEl = h("div", { class: "problem-body" });
  tmpnameRenderMathHtml01(bodyEl, problem.problem_html);

  const statusEl = h("div", { id: "out" });

  async function advance(skipped: boolean): Promise<void> {
    if (advancing) return;
    advancing = true;
    const elapsed = performance.now() - startedAt;

    try {
      // The attempt is recorded even when skipped -- a skip is still an
      // encounter with the problem, and still earns a square.
      await tmpnameRecordAttempt01(problem.id, runId, Math.round(elapsed), skipped);
      void tmpnameRefreshTrophyWall01();
      if (isLast) go({ name: "answers", runId });
      else go({ name: "problem", runId, problems, index: index + 1 });
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.className = "err";
      advancing = false;
    }
  }

  root.replaceChildren(
    h("div", { class: "problem-meta" }, [`${index + 1} of ${problems.length}`]),
    bodyEl,
    h("div", { class: "row" }, [
      h("button", { type: "button", id: "go", onclick: () => void advance(false) }, [
        isLast ? "next (finish)" : "next",
      ]),
      h("button", { type: "button", onclick: () => void advance(true) }, ["skip"]),
    ]),
    statusEl,
  );
}
