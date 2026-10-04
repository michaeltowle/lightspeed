import { solveEachStepByStep, buildToOrderFromPrompt, openPracticeRun } from "../api";
import { h } from "../lib/dom";
import { renderUnsavedScreenshots } from "../lib/unsaved-screenshots";
import type { StudyContextTag, View } from "../types";
import { renderClassAndAssignmentFilingFields } from "./add-assignment";

// The browser tab's own title, while a request is out and once it is back. A
// request runs long enough to go and do something else, and then the tab is
// the only part of the page in view. Module scope, because the pane can be
// rebuilt while a request is still out and the title is the page's, not the
// pane's.
const RESTING_TITLE = "lightspeed";
let titleEllipsisTimer: number | undefined;
let stopWaitingToBeSeen: (() => void) | null = null;

function showGeneratingInTitle(): void {
  stopWaitingToBeSeen?.();
  window.clearInterval(titleEllipsisTimer);
  let dots = 0;
  const paint = () => {
    dots = (dots % 4) + 1;
    document.title = `${RESTING_TITLE} — generating${".".repeat(dots)}`;
  };
  paint();
  titleEllipsisTimer = window.setInterval(paint, 450);
}

/**
 * Held until the page is come back to: the tab clicked from another tab, the
 * window from another app, or a click in the page if it never went away.
 */
function showGenerationEndInTitle(how: "complete" | "failed"): void {
  window.clearInterval(titleEllipsisTimer);
  document.title = `${RESTING_TITLE} — generation ${how}`;
  const seen = () => {
    if (document.visibilityState !== "visible") return;
    stopWaitingToBeSeen?.();
    document.title = RESTING_TITLE;
  };
  window.addEventListener("focus", seen);
  document.addEventListener("visibilitychange", seen);
  document.addEventListener("pointerdown", seen);
  stopWaitingToBeSeen = () => {
    window.removeEventListener("focus", seen);
    document.removeEventListener("visibilitychange", seen);
    document.removeEventListener("pointerdown", seen);
    stopWaitingToBeSeen = null;
  };
}

/**
 * Free generate: a prompt window, and screenshots pasted under it.
 *
 * Say what to practice, in whatever words -- how many, how hard -- and the
 * model finds problems that fit or invents them. The bank does not go with it,
 * so a pasted screenshot is how a request points at a problem: "like this one"
 * points at a page rather than describing it. There is no count field: the
 * request carries the count. The class and the assignment are both optional;
 * a request given no assignment is filed as a generated set of its own.
 *
 * The problems are solved as they land, so they are gradeable by the time they
 * are offered, and the press ends by offering them straight back as a run.
 */
export function renderFreeGenerate(
  onProblemsArrived: () => void,
  getTagCatalogue: () => StudyContextTag[],
  go: (view: View) => void,
): { el: HTMLElement; refreshTagChips: () => void } {
  let justMade: number[] = [];

  const fields = renderClassAndAssignmentFilingFields(getTagCatalogue, "blank files it as a generated set");

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
      go({ name: "continuous_scroll_practice_run", runId: run.run_id, problems: run.problems });
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
    showGeneratingInTitle();
    try {
      const { problem_ids } = await buildToOrderFromPrompt(
        request,
        tray.screenshots,
        fields.tagsToApply(),
      );
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
      showGenerationEndInTitle("complete");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
      showGenerationEndInTitle("failed");
    } finally {
      generateEl.disabled = false;
    }
  }

  generateEl.addEventListener("click", () => void generate());
  // The request is the one thing on the page that must be filled, so sending
  // it should not need the mouse.
  promptEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void generate();
    }
  });

  const el = h("div", {}, [
    fields.el,
    promptEl,
    tray.el,
    h("div", { class: "row" }, [generateEl]),
    workRowEl,
    statusEl,
  ]);

  return { el, refreshTagChips: fields.refreshTagChips };
}
