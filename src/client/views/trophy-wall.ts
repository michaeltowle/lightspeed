import { trophyWall } from "../api";
import { h } from "../lib/dom";
import type { Trophy } from "../types";

// The wall is not a view you navigate to -- it is a fixed layer mounted once,
// behind every other view, for the life of the page.
let layer: HTMLElement | null = null;

export function mountTrophyWall(): HTMLElement {
  if (layer) return layer;
  layer = h("div", { id: "trophy-wall", "aria-hidden": "true" });
  document.body.prepend(layer);
  return layer;
}

/** Exported so a bank row's strip is the same square, not a lookalike. */
export function square(trophy: Trophy): HTMLElement {
  // The worker sends answered attempts only, so there is no ungraded square
  // and no skipped one. Partial earns one too: it is a problem answered.
  return h("i", {
    class: `trophy trophy-${trophy.outcome}`,
    title: trophy.created_at,
  });
}

/**
 * The wall is hidden on the bank, where every row already carries its own strip
 * of the same squares: one wall behind a hundred little walls is noise, and the
 * rows say which problem earned what, which the wall never could.
 * It stays up everywhere else.
 */
export function setTrophyWallVisible(visible: boolean): void {
  mountTrophyWall().hidden = !visible;
}

export async function refreshTrophyWall(): Promise<void> {
  const target = mountTrophyWall();
  try {
    const { attempts } = await trophyWall();
    target.replaceChildren(...attempts.map(square));
  } catch {
    // The wall is ornamental; a failure here must never block practising.
  }
}
