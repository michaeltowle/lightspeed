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

function square(trophy: Trophy): HTMLElement {
  // The worker sends graded attempts only, so there is no ungraded square.
  return h("i", {
    class: `trophy trophy-${trophy.self_grade}`,
    title: trophy.created_at,
  });
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
