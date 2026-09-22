import { listEditablePerJobInstructionsToLlm, saveEditablePerJobInstructionsToLlm } from "../api";
import { formatAgo, h } from "../lib/dom";
import type { LlmJob, EditablePerJobInstructionsToLlm } from "../types";

/**
 * One box per LLM job, holding the whole of what that job is told.
 *
 * Nothing is added to these on the way out but the material of the call
 * itself, and each box says what that material is, so there is no hidden
 * layer to wonder about. A save writes a new revision rather than overwriting,
 * so an edit that makes things worse can be walked back.
 *
 * Authoring, so it is for a wide screen: below one the boxes are hidden and
 * the page says why, rather than offering a cramped editor.
 */
const JOBS: { job: LlmJob; title: string; sentWith: string }[] = [
  {
    job: "transcribe_from_screenshot",
    title: "transcribe",
    sentWith:
      "Sent with: one screenshot per call, and the note typed under the screenshots if there is one.",
  },
  {
    job: "build_to_order_from_prompt",
    title: "free generate",
    sentWith:
      "Sent with: every problem in the bank that is not archived, with its class, assignment and " +
      "number; the problems this same request has produced before; then the request.",
  },
  {
    job: "solve_step_by_step",
    title: "solve",
    sentWith:
      "Sent with: the problem, the class and assignment it is filed under, and, when it has " +
      "instructions of its own, those instructions and the solution being redone.",
  },
];

export function renderEditablePerJobInstructionsToLlm(): { el: HTMLElement; load: () => Promise<void> } {
  const sectionsEl = h("div", { class: "editable-per-job-instructions-to-llm-editor" });
  const statusEl = h("div", { id: "out" });
  let loaded = false;

  function section(row: EditablePerJobInstructionsToLlm, title: string, sentWith: string): HTMLElement {
    let inForce = row.system_prompt_text;
    const boxEl = h("textarea", { class: "editable-per-job-instructions-to-llm-box", spellcheck: "false" });
    boxEl.value = inForce;

    const saveEl = h("button", { type: "button", disabled: true }, ["save"]);
    const revertEl = h("button", { type: "button", disabled: true }, ["revert"]);
    const stateEl = h("span", { class: "editable-per-job-instructions-to-llm-state" });
    let savedAt = row.created_at;

    const paint = () => {
      const dirty = boxEl.value !== inForce;
      saveEl.disabled = !dirty;
      revertEl.disabled = !dirty;
      stateEl.textContent = dirty ? "unsaved" : `in force since ${formatAgo(savedAt)}`;
      stateEl.classList.toggle("is-dirty", dirty);
    };

    boxEl.addEventListener("input", paint);
    revertEl.addEventListener("click", () => {
      boxEl.value = inForce;
      paint();
    });
    saveEl.addEventListener("click", async () => {
      saveEl.disabled = true;
      stateEl.textContent = "saving...";
      try {
        const { saved } = await saveEditablePerJobInstructionsToLlm(row.llm_job, boxEl.value);
        inForce = saved.system_prompt_text;
        savedAt = saved.created_at;
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : String(err);
        statusEl.className = "err";
      }
      paint();
    });

    paint();
    return h("section", { class: "editable-per-job-instructions-to-llm-section" }, [
      h("h2", {}, [title]),
      h("div", { class: "bank-note" }, [sentWith]),
      boxEl,
      h("div", { class: "row" }, [saveEl, revertEl, stateEl]),
    ]);
  }

  async function load(): Promise<void> {
    // Once per page: loading again would overwrite an edit in progress.
    if (loaded) return;
    loaded = true;
    sectionsEl.replaceChildren(h("div", { class: "bank-note" }, ["loading..."]));
    try {
      const { instructions } = await listEditablePerJobInstructionsToLlm();
      const byJob = new Map(instructions.map((row) => [row.llm_job, row]));
      sectionsEl.replaceChildren(
        ...JOBS.map(({ job, title, sentWith }) => {
          const row = byJob.get(job);
          return row
            ? section(row, title, sentWith)
            : h("div", { class: "bank-note err" }, [`nothing saved for ${title}`]);
        }),
      );
    } catch (err) {
      loaded = false;
      sectionsEl.replaceChildren();
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      statusEl.className = "err";
    }
  }

  const el = h("div", {}, [
    h("div", { class: "bank-note editable-per-job-instructions-to-llm-narrow-note" }, [
      "the instructions are edited on a wider screen",
    ]),
    sectionsEl,
    statusEl,
  ]);
  return { el, load };
}
