import { solveEachStepByStep, buildToOrderFromPrompt, openPracticeRun } from "../api";
import { h } from "../lib/dom";
import { renderUnsavedScreenshots } from "../lib/unsaved-screenshots";
import type { View } from "../types";

/**
 * Free generate: a prompt window, and screenshots pasted under it.
 *
 * Say what to practice, in whatever words -- how many, how hard, which bank
 * problem to work from -- and the model finds problems that fit or invents
 * them. A pasted screenshot goes along with the words -- "like this one" can
 * point at a page rather than describe it. There is no count field and no filing: the request carries the count,
 * and what it mints is found under the generated tab by how it came to be.
 *
 * The problems are solved as they land, so they are gradeable by the time they
 * are offered, and the press ends by offering them straight back as a run.
 */
export function renderFreeGenerate(
  onProblemsArrived: () => void,
  go: (view: View) => void,
): HTMLElement {
  let justMade: number[] = [];

  const statusEl = h("div", { id: "out" });
  const setStatus = (text: string, isError = false) => {
    statusEl.textContent = text;
    statusEl.className = isError ? "err" : "";
  };

  const promptEl = h("textarea", {
    class: "free-generate-prompt",
    rows: 4,
    placeholder:
      "what to practice -- e.g. four problems like 2.3(a) from homework 3, but discrete",
  });

  const tray = renderUnsavedScreenshots((message) => setStatus(message, true));

  const workEl = h("button", { type: "button", id: "go" }, ["work it now"]);
  const workRowEl = h("div", { class: "row" }, [workEl]);
  workRowEl.hidden = true;

  workEl.addEventListener("click", async () => {
    if (!justMade.length) return;
    workEl.disabled = true;
    setStatus("opening...");
    try {
      const run = await openPracticeRun(justMade);
      if (!run.problems.length) throw new Error("nothing to serve");
      go({ name: "problem", runId: run.run_id, problems: run.problems, index: 0 });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
      workEl.disabled = false;
    }
  });

  const generateEl = h("button", { type: "button", id: "go" }, ["generate"]);

  async function generate(): Promise<void> {
    const request = promptEl.value.trim();
    if (!request && !tray.screenshots.length) {
      setStatus("say what to generate first", true);
      return;
    }
    generateEl.disabled = true;
    workRowEl.hidden = true;
    setStatus("finding problems...");
    try {
      const { problem_ids } = await buildToOrderFromPrompt(request, tray.screenshots);
      tray.empty();
      const n = problem_ids.length;
      const plural = n === 1 ? "" : "s";
      const { failed } = await solveEachStepByStep(problem_ids, (done, failedSoFar) =>
        setStatus(
          `${n} problem${plural} written. solving them (${done}/${n})` +
            (failedSoFar ? ` — ${failedSoFar} could not be solved` : "") +
            "...",
        ),
      );
      justMade = problem_ids;
      onProblemsArrived();
      setStatus(
        `${n} problem${plural} in the generated tab` +
          (failed ? `, ${failed} still unsolved` : ", all solved"),
      );
      workRowEl.hidden = false;
      workEl.disabled = false;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      generateEl.disabled = false;
    }
  }

  generateEl.addEventListener("click", () => void generate());
  // The request is the only thing on the page, so sending it should not need
  // the mouse.
  promptEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void generate();
    }
  });

  return h("div", {}, [
    promptEl,
    tray.el,
    h("div", { class: "row" }, [generateEl]),
    workRowEl,
    statusEl,
  ]);
}
