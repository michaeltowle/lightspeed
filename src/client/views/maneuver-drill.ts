import { breakIntoManeuvers, openPracticeRun, drillOneManeuver } from "../api";
import { h } from "../lib/dom";
import type { View } from "../types";

/** Enough to get the move into the hand, few enough to keep the wait short. */
const DRILLS_PER_PRESS = 3;

/**
 * A tab that drills one maneuver.
 *
 * Opened from the drill button on a maneuver row, always into a tab of its
 * own: the point is to practise the step that just defeated you without
 * losing the homework you were in the middle of. The run carries on in the
 * tab behind this one.
 *
 * Nothing is asked of Mike here. The tab writes the drills, breaks them into
 * their own tables and opens them as a run, so the only thing to do is wait
 * -- and waiting is free, because the tab he came from is still where he left
 * it. That is why this takes the long way round rather than trying to be
 * quick: forty seconds in a background tab costs nothing.
 */
export function renderManeuverDrill(
  root: HTMLElement,
  maneuverId: number,
  go: (view: View) => void,
): void {
  const statusEl = h("div", { id: "out" }, ["writing drills..."]);
  const titleEl = h("h1", {}, ["drill"]);

  const say = (text: string, isError = false) => {
    statusEl.textContent = text;
    statusEl.className = isError ? "err" : "";
  };

  root.replaceChildren(titleEl, statusEl);

  void (async () => {
    let problemIds: number[];
    try {
      const drilled = await drillOneManeuver(maneuverId, DRILLS_PER_PRESS);
      problemIds = drilled.problem_ids;
      titleEl.textContent = drilled.maneuver_name;
    } catch (err) {
      // A step that carries no skill of its own says so here rather than
      // handing over three problems that only look like practice.
      say(err instanceof Error ? err.message : String(err), true);
      return;
    }

    // Each drill needs its own table before it can be graded. Fired together,
    // and a failure costs that drill its answer key rather than the set.
    let done = 0;
    let failed = 0;
    const tick = () =>
      say(
        `${problemIds.length} drills written. breaking them down ` +
          `(${done}/${problemIds.length})` +
          (failed ? ` — ${failed} could not be broken` : "") +
          "...",
      );
    tick();

    await Promise.all(
      problemIds.map(async (id) => {
        try {
          await breakIntoManeuvers(id);
        } catch {
          failed += 1;
        } finally {
          done += 1;
          tick();
        }
      }),
    );

    say("opening...");
    try {
      const run = await openPracticeRun(problemIds);
      if (!run.problems.length) throw new Error("nothing to serve");
      go({ name: "problem", runId: run.run_id, problems: run.problems, index: 0 });
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    }
  })();
}
