import { solveEachStepByStep, openPracticeRun, transcribeFromScreenshot } from "../api";
import { h } from "../lib/dom";
import { renderUnsavedScreenshots } from "../lib/unsaved-screenshots";
import type { StudyContextTag, StudyContextTagField, View } from "../types";

/** A typed comma list into tag names: trimmed, squashed, de-duplicated. */
export function parseTagNames(raw: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.replace(/\s+/g, " ").trim().slice(0, 32);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
    if (names.length === 8) break;
  }
  return names;
}

/**
 * Adding a whole assignment at once.
 *
 * The unit here is the assignment, not the problem: the class and the piece of
 * work are stated once at the top, every screenshot for the whole thing is
 * pasted under them, and one press turns the lot into problems wearing both
 * tags. That is the only grouping there is -- an assignment is a label its
 * problems wear, never a parent -- which is what lets the set be filtered back
 * out of the bank and served again weeks later without anything owning it.
 *
 * The press ends by offering the set straight back as a run, because the point
 * of adding a homework is to sit down and work it, not to go and find it again.
 */
export function renderAddAssignment(
  onProblemsArrived: () => void,
  getTagCatalogue: () => StudyContextTag[],
  go: (view: View) => void,
): { el: HTMLElement; refreshTagChips: () => void } {
  let chosenClass: string | null = null;
  // What the last read produced, kept so the set can be worked without being
  // looked up again.
  let justAdded: number[] = [];
  // Screenshots the last read could make nothing of. They are gone from the
  // server by the time this is set; re-pasting is the retry.
  let unreadableScreenshotCount = 0;

  const statusEl = h("div", { id: "out" });
  const setStatus = (text: string, isError = false) => {
    statusEl.textContent = text;
    statusEl.className = isError ? "err" : "";
  };

  // ---- which class, and which piece of work ---------------------------------
  //
  // One class, chosen rather than typed: the classes are known and few, and an
  // assignment belongs to exactly one of them. A class that does not exist yet
  // is still reachable -- the bank's own tag editing creates one by name.
  const classChipsEl = h("div", { class: "compose-field-chips" });

  function paintClassChips(): void {
    classChipsEl.replaceChildren(
      ...getTagCatalogue()
        .filter((tag) => tag.field === "class")
        .map((tag) =>
          h(
            "button",
            {
              type: "button",
              class: `study-context-tag-chip chip-color-${tag.chip_color_ordinal}${
                chosenClass?.toLowerCase() === tag.name.toLowerCase() ? " is-on" : ""
              }`,
              onclick: () => {
                chosenClass =
                  chosenClass?.toLowerCase() === tag.name.toLowerCase() ? null : tag.name;
                paintClassChips();
              },
            },
            [tag.name],
          ),
        ),
    );
  }

  const assignmentEl = h("input", { type: "text" });

  const tagsToApply = (): Partial<Record<StudyContextTagField, string[]>> => {
    const out: Partial<Record<StudyContextTagField, string[]>> = {};
    if (chosenClass) out.class = [chosenClass];
    const assignment = parseTagNames(assignmentEl.value)[0];
    if (assignment) out.assignment = [assignment];
    return out;
  };

  // ---- the screenshots ------------------------------------------------------
  const tray = renderUnsavedScreenshots((message) => setStatus(message, true));
  const noteEl = h("textarea", {});

  // ---- working the set straight away ----------------------------------------
  const workEl = h("button", { type: "button", id: "go" }, ["work it now"]);
  const workRowEl = h("div", { class: "row" }, [workEl]);
  workRowEl.hidden = true;

  workEl.addEventListener("click", async () => {
    if (!justAdded.length) return;
    workEl.disabled = true;
    setStatus("opening...");
    try {
      // Exactly what was just added, in the order it was read off the page.
      const run = await openPracticeRun(justAdded);
      if (!run.problems.length) throw new Error("nothing to serve");
      go({ name: "problem", runId: run.run_id, problems: run.problems, index: 0 });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
      workEl.disabled = false;
    }
  });

  // ---- reading the assignment off the page ----------------------------------
  //
  // Solving is fired per problem and in parallel: the statements are already
  // saved, so a failure here costs a table and not the assignment -- it can be
  // solved later from the bank.
  async function solveThem(problemIds: number[]): Promise<void> {
    const n = problemIds.length;
    const plural = n === 1 ? "" : "s";
    const { failed } = await solveEachStepByStep(problemIds, (done, failedSoFar) =>
      setStatus(
        `${n} problem${plural} in. solving them (${done}/${n})` +
          (failedSoFar ? ` — ${failedSoFar} could not be solved` : "") +
          "...",
      ),
    );

    justAdded = problemIds;
    workRowEl.hidden = false;
    workEl.disabled = false;

    setStatus(
      `${n} problem${plural} in the bank` +
        (failed ? `, ${failed} still unsolved` : ", all solved") +
        (unreadableScreenshotCount
          ? ` — ${unreadableScreenshotCount} screenshot` +
            `${unreadableScreenshotCount === 1 ? "" : "s"} unreadable, paste again`
          : ""),
    );
    onProblemsArrived();
  }

  const readEl = h("button", { type: "button", id: "go" }, ["load problems"]);
  readEl.addEventListener("click", async () => {
    if (!chosenClass) {
      setStatus("pick a class first", true);
      return;
    }
    if (!parseTagNames(assignmentEl.value).length) {
      setStatus("name the assignment first", true);
      return;
    }
    if (!tray.screenshots.length) {
      setStatus("paste the screenshots first", true);
      return;
    }
    readEl.disabled = true;
    workRowEl.hidden = true;
    setStatus("reading...");
    try {
      const read = await transcribeFromScreenshot(
        tray.screenshots,
        noteEl.value,
        tagsToApply(),
      );
      tray.empty();
      unreadableScreenshotCount = read.unreadable_screenshot_count;
      await solveThem(read.problem_ids);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      readEl.disabled = false;
    }
  });

  paintClassChips();

  const el = h("div", {}, [
    h("div", { class: "compose-fields" }, [
      // No label over the chips: 6801 names its own field, and the word only
      // repeated what the chips already said.
      h("div", { class: "compose-field" }, [classChipsEl]),
      h("div", { class: "compose-field" }, [
        h("span", { class: "compose-field-name" }, ["assignment name"]),
        assignmentEl,
      ]),
    ]),

    tray.el,
    noteEl,
    h("div", { class: "row" }, [readEl]),

    workRowEl,
    statusEl,
  ]);

  return { el, refreshTagChips: paintClassChips };
}
