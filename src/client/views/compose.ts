import { generateProblems } from "../api";
import { clear, h } from "../lib/dom";
import type { View, UnsavedImageAttachment } from "../types";

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

export function renderCompose(
  root: HTMLElement,
  go: (view: View) => void,
): void {
  const attachments: UnsavedImageAttachment[] = [];

  const promptEl = h("textarea", { id: "prompt" });
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
  document.addEventListener("paste", (event) => {
    const clipboard = (event as ClipboardEvent).clipboardData;
    if (!clipboard) return;
    const files = Array.from(clipboard.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
    }
  });

  const form = h("form", {
    id: "f",
    onsubmit: async (event: Event) => {
      event.preventDefault();
      goEl.disabled = true;
      setStatus("generating...");
      try {
        const count = Math.max(1, Math.min(40, Number(countEl.value) || 2));
        const set = await generateProblems(promptEl.value, attachments, count);
        if (!set.problems.length) throw new Error("model returned no problems");
        go({ name: "problem", runId: set.run_id, problems: set.problems, index: 0 });
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), true);
        goEl.disabled = false;
      }
    },
  });

  form.append(
    promptEl,
    thumbsEl,
    h("div", { class: "row" }, [countEl, goEl]),
  );

  root.replaceChildren(h("h1", {}, ["limitations are in the mind"]), form, statusEl);
}
