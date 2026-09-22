import { solveStepByStep, setEditablePerProblemInstructionsToLlm } from "../api";
import { h } from "./dom";

/**
 * Redoing a solution in place: say how this one should be solved, then
 * re-solve it. The problem, its attempts and their recorded credit all stay;
 * only the table is replaced. When the problem has words of its own, the table
 * being replaced goes to the model with them, so "step 3 is wrong" has a step 3
 * to mean.
 *
 * The words are kept on the problem rather than on the press, so every later
 * solve reads them -- including one fired from the bank weeks from now after
 * the instructions change. Saved on blur, like the why box, and again on the
 * way into a solve so the solve never reads a stale one.
 *
 * Handed back as two elements rather than one block, because the answers page
 * and the bank each have a row of buttons of their own for the button to join.
 */
export function renderReSolveControls(options: {
  problemId: number;
  editablePerProblemInstructionsToLlm: string;
  alreadySolved: boolean;
  /** Asked before solving; false stops it. For when there is grading to lose. */
  mayProceed?: () => boolean;
  onHowSaved?: (text: string) => void;
  onReSolved: () => void;
}): { howEl: HTMLTextAreaElement; solveEl: HTMLButtonElement } {
  const { problemId, alreadySolved, mayProceed, onHowSaved, onReSolved } = options;

  const howEl = h("textarea", {
    class: "editable-per-problem-instructions-to-llm-box",
    rows: 1,
    placeholder: "how should this one be solved? read every time it is solved",
  });
  howEl.value = options.editablePerProblemInstructionsToLlm;
  let savedHow = options.editablePerProblemInstructionsToLlm;

  const saveHow = async (): Promise<void> => {
    const next = howEl.value.trim();
    if (next === savedHow) return;
    await setEditablePerProblemInstructionsToLlm(problemId, next);
    savedHow = next;
    onHowSaved?.(next);
  };
  howEl.addEventListener("blur", () => {
    void saveHow().catch(() => {
      // Nothing saved, so the box should not claim otherwise.
      howEl.value = savedHow;
    });
  });

  const label = alreadySolved ? "re-solve" : "solve";
  const solveEl = h("button", { type: "button", class: "grade" }, [label]);
  solveEl.addEventListener("click", async () => {
    if (mayProceed && !mayProceed()) return;
    solveEl.disabled = true;
    solveEl.textContent = "solving...";
    try {
      await saveHow();
      await solveStepByStep(problemId);
      onReSolved();
    } catch (err) {
      solveEl.textContent = err instanceof Error ? err.message : String(err);
      solveEl.disabled = false;
    }
  });

  return { howEl, solveEl };
}
