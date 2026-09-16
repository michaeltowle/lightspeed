import { generateProblems, saveNamedProblemGenerator } from "../api";
import { clear, h } from "../lib/dom";
import { STUDY_CONTEXT_TAG_FIELDS } from "../types";
import type {
  StudyContextTag,
  StudyContextTagField,
  View,
  UnsavedImageAttachment,
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

const MAX_ATTACHMENTS = 8;
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
function reencode(img: HTMLImageElement): UnsavedImageAttachment {
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
// screen. The dashboard re-renders on every rename and archive, so a listener
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
 * The box that turns a typed prompt into a new practice type.
 *
 * Returns its element rather than owning the page -- the dashboard decides where
 * it sits -- alongside a repaint for the tag chips, which go stale whenever a
 * tag is created or retired from the table while this form is already built.
 *
 * The catalogue arrives as a getter for the same reason: it is read at paint
 * time, not captured once when the form is made.
 */
export function renderNewGeneratorForm(
  go: (view: View) => void,
  getTagCatalogue: () => StudyContextTag[],
): { el: HTMLElement; refreshTagChips: () => void } {
  const attachments: UnsavedImageAttachment[] = [];

  const promptEl = h("textarea", { id: "prompt" });
  const nameEl = h("input", { id: "name", type: "text" });

  // The same four fields the table carries, so a type arrives already placed
  // rather than needing a second pass over the dashboard to file it.
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
  const countEl = h("input", {
    id: "count",
    type: "number",
    min: 1,
    max: 40,
    value: 2,
  });
  const thumbsEl = h("ul", { class: "shots" });
  const statusEl = h("div", { id: "out" });
  const goEl = h("button", { type: "submit", id: "go" }, ["generate"]);
  const saveEl = h("button", { type: "button", id: "save" }, ["save"]);

  const setStatus = (text: string, isError = false) => {
    statusEl.textContent = text;
    statusEl.className = isError ? "err" : "";
  };

  function renderThumbs(): void {
    clear(thumbsEl);
    attachments.forEach((shot, idx) => {
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
                attachments.splice(idx, 1);
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
      if (attachments.length + pending.length >= MAX_ATTACHMENTS) {
        setStatus(`limit is ${MAX_ATTACHMENTS} images`, true);
        break;
      }
      pending.push(file);
    }
    try {
      for (const file of pending) {
        attachments.push(reencode(await loadImage(await readFile(file))));
      }
      renderThumbs();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }

  // Paste is the only way images get in -- there is no file picker.
  acceptPastedFiles = (files) => void addFiles(files);

  /** Everything typed into the box, in the shape both buttons send. */
  function composed() {
    const tagsByField: Partial<Record<StudyContextTagField, string[]>> = {};
    for (const [field, input] of fieldInputs) {
      const names = parseTagNames(input.value);
      if (names.length) tagsByField[field] = names;
    }
    return {
      prompt: promptEl.value,
      count: Math.max(1, Math.min(40, Number(countEl.value) || 2)),
      name: nameEl.value.replace(/\s+/g, " ").trim().slice(0, 64),
      tagsByField,
    };
  }

  const setBusy = (busy: boolean) => {
    goEl.disabled = busy;
    saveEl.disabled = busy;
  };

  // Files the type away without spending a generate on it. Everything else is
  // the same -- prompt, name, screenshots, fields, remembered count -- so it
  // lands in the table ready to be practised whenever it is wanted.
  saveEl.addEventListener("click", async () => {
    setBusy(true);
    setStatus("saving...");
    try {
      const { prompt, count, name, tagsByField } = composed();
      await saveNamedProblemGenerator(prompt, attachments, count, name, tagsByField);
      // Re-entering the view refetches, and the table is the tab it opens on.
      go({ name: "generators" });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
      setBusy(false);
    }
  });

  const form = h("form", {
    id: "f",
    onsubmit: async (event: Event) => {
      event.preventDefault();
      setBusy(true);
      setStatus("generating...");
      try {
        const { prompt, count, name, tagsByField } = composed();
        const set = await generateProblems(prompt, attachments, count, name, tagsByField);
        if (!set.problems.length) throw new Error("model returned no problems");
        go({
          name: "problem",
          runId: set.run_id,
          requestedCount: set.requested_count,
          problems: set.problems,
          index: 0,
        });
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), true);
        setBusy(false);
      }
    },
  });

  form.append(
    promptEl,
    thumbsEl,
    h("div", { class: "compose-fields" }, [
      h("div", { class: "compose-field" }, [
        h("span", { class: "compose-field-name" }, ["name"]),
        nameEl,
      ]),
      ...STUDY_CONTEXT_TAG_FIELDS.map((field) =>
        h("div", { class: "compose-field" }, [
          h("span", { class: "compose-field-name" }, [field]),
          fieldInputs.get(field)!,
          fieldChipRows.get(field)!,
        ]),
      ),
    ]),
    h("div", { class: "row" }, [countEl, goEl, saveEl]),
  );

  paintTagChips();

  return {
    el: h("div", {}, [form, statusEl]),
    refreshTagChips: paintTagChips,
  };
}
