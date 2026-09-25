import { clear, h } from "./dom";
import type { UnsavedScreenshot } from "../types";

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

// One listener, bound once at module scope, handing each paste to whichever
// tray is on screen. The bank keeps every pane mounted and only hides the ones
// not showing, and it re-renders on every rename and retag -- so a listener per
// tray would stack, and "the last one rendered" is not "the one being looked
// at". A tray whose render has been thrown away drops off the list here.
const trays: { el: HTMLElement; accept: (files: File[]) => void }[] = [];

document.addEventListener("paste", (event) => {
  for (let i = trays.length - 1; i >= 0; i--) {
    if (!trays[i].el.isConnected) trays.splice(i, 1);
  }
  const tray = trays.find((t) => !t.el.closest("[hidden]"));
  if (!tray) return;
  const clipboard = (event as ClipboardEvent).clipboardData;
  if (!clipboard) return;
  const files = Array.from(clipboard.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (files.length) {
    event.preventDefault();
    tray.accept(files);
  }
});

/**
 * Pasted screenshots, shrunk to fit and shown as thumbnails that can be
 * removed. Paste is the only way images get in -- there is no file picker.
 */
export function renderUnsavedScreenshots(onError: (message: string) => void): {
  el: HTMLElement;
  screenshots: UnsavedScreenshot[];
  empty: () => void;
} {
  const screenshots: UnsavedScreenshot[] = [];
  const el = h("ul", { class: "shots" });

  function renderThumbs(): void {
    clear(el);
    screenshots.forEach((shot, idx) => {
      el.append(
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

  async function addFiles(files: File[]): Promise<void> {
    const pending: File[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (screenshots.length + pending.length >= MAX_SCREENSHOTS) {
        onError(`limit is ${MAX_SCREENSHOTS} images`);
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
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  trays.push({ el, accept: (files) => void addFiles(files) });

  return {
    el,
    screenshots,
    empty: () => {
      screenshots.length = 0;
      renderThumbs();
    },
  };
}
