import {
  breakIntoManeuvers,
  buildToOrderFromPrompt,
  listScreenshotsAwaitingTranscription,
  transcribeFromScreenshot,
} from "../api";
import { clear, h } from "../lib/dom";
import { STUDY_CONTEXT_TAG_FIELDS } from "../types";
import type {
  AwaitingScreenshot,
  StudyContextTag,
  StudyContextTagField,
  UnsavedScreenshot,
} from "../types";

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

const MAX_SCREENSHOTS = 8;
// D1 caps a BLOB at 2,000,000 bytes; stay well under it.
const MAX_STORED_BYTES = 1_000_000;
const MAX_EDGE = 2000;

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode image"));
    img.src = dataUrl;
  });
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("could not read file"));
    fr.readAsDataURL(file);
  });
}

/** Re-encode to WebP, shrinking until the encoded bytes fit under the D1 cap. */
function reencode(img: HTMLImageElement): UnsavedScreenshot {
  let scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  let quality = 0.85;

  for (;;) {
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h2 = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h2;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h2);
    const dataUrl = canvas.toDataURL("image/webp", quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const byteSize = Math.floor((base64.length * 3) / 4);

    if (byteSize <= MAX_STORED_BYTES) {
      return { dataUrl, base64, mimeType: "image/webp", w, h: h2, byteSize };
    }
    if (quality > 0.5) quality -= 0.15;
    else if (scale > 0.25) scale *= 0.75;
    else return { dataUrl, base64, mimeType: "image/webp", w, h: h2, byteSize };
  }
}

// Bound once, at module scope, and pointed at whichever form is currently on
// screen. The bank re-renders on every rename and archive, so a listener
// attached per render would stack a new copy each time and paste an image once
// per render it had survived.
let acceptPastedFiles: ((files: File[]) => void) | null = null;

document.addEventListener("paste", (event) => {
  if (!acceptPastedFiles) return;
  const clipboard = (event as ClipboardEvent).clipboardData;
  if (!clipboard) return;
  const files = Array.from(clipboard.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (files.length) {
    event.preventDefault();
    acceptPastedFiles(files);
  }
});

/**
 * Everything that puts problems into the bank.
 *
 * Both routes end the same way: statements land first, then each problem is
 * broken into its maneuver table by a call of its own, fired in parallel. That
 * is what keeps a pasted homework page to one wait rather than one per problem,
 * and it is why breaking is a separate verb rather than part of the intake.
 */
export function renderIntake(
  onProblemsArrived: () => void,
  getTagCatalogue: () => StudyContextTag[],
): { el: HTMLElement; refreshTagChips: () => void } {
  const screenshots: UnsavedScreenshot[] = [];

  // ---- the shared filing controls -----------------------------------------
  const fieldInputs = new Map<StudyContextTagField, HTMLInputElement>(
    STUDY_CONTEXT_TAG_FIELDS.map((field) => [field, h("input", { type: "text" })]),
  );
  const fieldChipRows = new Map<StudyContextTagField, HTMLElement>(
    STUDY_CONTEXT_TAG_FIELDS.map((field) => [
      field,
      h("div", { class: "compose-field-chips" }),
    ]),
  );

  /**
   * Every tag the field already has, as a chip that puts its name into the box
   * or takes it out again. The box stays the single source of truth -- a chip
   * only edits the text in it -- so a name typed by hand and one clicked in are
   * the same thing by the time anything is sent.
   */
  function paintTagChips(): void {
    const catalogue = getTagCatalogue();
    for (const field of STUDY_CONTEXT_TAG_FIELDS) {
      const input = fieldInputs.get(field)!;
      const row = fieldChipRows.get(field)!;
      const chosen = new Set(parseTagNames(input.value).map((n) => n.toLowerCase()));

      row.replaceChildren(
        ...catalogue
          .filter((tag) => tag.field === field)
          .map((tag) =>
            h(
              "button",
              {
                type: "button",
                class: `study-context-tag-chip chip-color-${tag.chip_color_ordinal}${
                  chosen.has(tag.name.toLowerCase()) ? " is-on" : ""
                }`,
                onclick: () => {
                  const names = parseTagNames(input.value);
                  const at = names.findIndex(
                    (n) => n.toLowerCase() === tag.name.toLowerCase(),
                  );
                  if (at >= 0) names.splice(at, 1);
                  else names.push(tag.name);
                  input.value = names.join(", ");
                  paintTagChips();
                },
              },
              [tag.name],
            ),
          ),
      );
    }
  }

  for (const input of fieldInputs.values()) {
    input.addEventListener("input", paintTagChips);
  }

  const tagsByField = () => {
    const out: Partial<Record<StudyContextTagField, string[]>> = {};
    for (const [field, input] of fieldInputs) {
      const names = parseTagNames(input.value);
      if (names.length) out[field] = names;
    }
    return out;
  };

  const statusEl = h("div", { id: "out" });
  const setStatus = (text: string, isError = false) => {
    statusEl.textContent = text;
    statusEl.className = isError ? "err" : "";
  };

  // ---- breaking, which both routes finish with ------------------------------
  //
  // Fired in parallel and reported as it goes: the statements are already
  // saved, so a failure here costs the table and not the problems -- they can
  // be broken later from the bank or from the answers page.
  async function breakThemDown(problemIds: number[]): Promise<void> {
    let done = 0;
    let failed = 0;
    const tick = () =>
      setStatus(
        `${problemIds.length} problem${problemIds.length === 1 ? "" : "s"} in. ` +
          `breaking them down (${done}/${problemIds.length})` +
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

    setStatus(
      `${problemIds.length} problem${problemIds.length === 1 ? "" : "s"} in the bank` +
        (failed ? `, ${failed} still needing a table` : ", all broken into maneuvers"),
    );
    onProblemsArrived();
  }

  // ---- route one: read them off a screenshot -------------------------------
  const thumbsEl = h("ul", { class: "shots" });
  const noteEl = h("textarea", {
    placeholder: "anything the screenshot does not say (optional)",
  });

  function renderThumbs(): void {
    clear(thumbsEl);
    screenshots.forEach((shot, idx) => {
      thumbsEl.append(
        h("li", {}, [
          h("img", { src: shot.dataUrl, alt: "" }),
          h("div", { class: "dims" }, [
            `${idx + 1}: ${shot.w}x${shot.h} (${Math.round(shot.byteSize / 1024)}kb)`,
          ]),
          h(
            "button",
            {
              type: "button",
              class: "drop",
              onclick: () => {
                screenshots.splice(idx, 1);
                renderThumbs();
              },
            },
            ["remove"],
          ),
        ]),
      );
    });
  }

  async function addFiles(files: FileList | File[]): Promise<void> {
    const pending: File[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (screenshots.length + pending.length >= MAX_SCREENSHOTS) {
        setStatus(`limit is ${MAX_SCREENSHOTS} images`, true);
        break;
      }
      pending.push(file);
    }
    try {
      for (const file of pending) {
        screenshots.push(reencode(await loadImage(await readFile(file))));
      }
      renderThumbs();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }

  // Paste is the only way images get in -- there is no file picker.
  acceptPastedFiles = (files) => void addFiles(files);

  const transcribeEl = h("button", { type: "button", id: "go" }, ["read the problems off it"]);
  transcribeEl.addEventListener("click", async () => {
    if (!screenshots.length) {
      setStatus("paste a screenshot first", true);
      return;
    }
    transcribeEl.disabled = true;
    setStatus("reading...");
    try {
      const { problem_ids } = await transcribeFromScreenshot(
        screenshots,
        noteEl.value,
        tagsByField(),
      );
      screenshots.length = 0;
      renderThumbs();
      await breakThemDown(problem_ids);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      transcribeEl.disabled = false;
    }
  });

  // ---- route two: write them to order --------------------------------------
  const promptEl = h("textarea", {
    placeholder: "e.g. u-substitution with new limits, moderate difficulty",
  });
  const countEl = h("input", { type: "number", min: 1, max: 40, value: 2 });
  const buildEl = h("button", { type: "button", id: "go" }, ["write them"]);

  buildEl.addEventListener("click", async () => {
    const prompt = promptEl.value.trim();
    if (!prompt) {
      setStatus("type a prompt first", true);
      return;
    }
    buildEl.disabled = true;
    setStatus("writing...");
    try {
      const { problem_ids } = await buildToOrderFromPrompt(
        prompt,
        Math.max(1, Math.min(40, Number(countEl.value) || 2)),
        tagsByField(),
      );
      await breakThemDown(problem_ids);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      buildEl.disabled = false;
    }
  });

  // ---- screenshots carried in but not yet read -----------------------------
  const awaitingEl = h("div", {});

  async function paintAwaiting(): Promise<void> {
    let waiting: AwaitingScreenshot[];
    try {
      ({ screenshots: waiting } = await listScreenshotsAwaitingTranscription());
    } catch {
      return;
    }
    if (!waiting.length) {
      awaitingEl.replaceChildren();
      return;
    }

    awaitingEl.replaceChildren(
      h("div", { class: "compose-field-name" }, [
        `${waiting.length} screenshot${waiting.length === 1 ? "" : "s"} awaiting transcription`,
      ]),
      h(
        "ul",
        { class: "shots" },
        waiting.map((shot) => {
          const readEl = h("button", { type: "button", class: "drop" }, ["read it"]);
          readEl.addEventListener("click", async () => {
            readEl.disabled = true;
            setStatus("reading...");
            try {
              const { problem_ids } = await transcribeFromScreenshot(
                [],
                noteEl.value,
                tagsByField(),
                [shot.id],
              );
              await breakThemDown(problem_ids);
              void paintAwaiting();
            } catch (err) {
              setStatus(err instanceof Error ? err.message : String(err), true);
              readEl.disabled = false;
            }
          });
          return h("li", {}, [
            h("a", { href: `/?shot=${shot.id}`, target: "_blank", rel: "noreferrer" }, [
              h("img", { src: `/?shot=${shot.id}`, alt: "" }),
            ]),
            h("div", { class: "dims" }, [`${shot.width_px}x${shot.height_px}`]),
            readEl,
          ]);
        }),
      ),
    );
  }
  void paintAwaiting();

  paintTagChips();

  const el = h("div", {}, [
    h("div", { class: "compose-field-name" }, [
      "filing — applied to every problem this intake produces",
    ]),
    h(
      "div",
      { class: "compose-fields" },
      STUDY_CONTEXT_TAG_FIELDS.map((field) =>
        h("div", { class: "compose-field" }, [
          h("span", { class: "compose-field-name" }, [field]),
          fieldInputs.get(field)!,
          fieldChipRows.get(field)!,
        ]),
      ),
    ),

    h("h1", {}, ["off a screenshot"]),
    h("div", { class: "bank-note" }, [
      "paste one. lettered parts come back as separate problems, each one whole.",
    ]),
    thumbsEl,
    noteEl,
    h("div", { class: "row" }, [transcribeEl]),
    awaitingEl,

    h("h1", {}, ["to order"]),
    promptEl,
    h("div", { class: "row" }, [countEl, buildEl]),

    statusEl,
  ]);

  return { el, refreshTagChips: paintTagChips };
}
