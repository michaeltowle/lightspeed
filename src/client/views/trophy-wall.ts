import { tmpnameTrophyWall01 } from "../api";
import { h } from "../lib/dom";
import type { TmpnameTrophy01 } from "../types";

// The wall is not a view you navigate to -- it is a fixed layer mounted once,
// behind every other view, for the life of the page.
let layer: HTMLElement | null = null;

export function tmpnameMountTrophyWall01(): HTMLElement {
  if (layer) return layer;
  layer = h("div", { id: "trophy-wall", "aria-hidden": "true" });
  document.body.prepend(layer);
  return layer;
}

function square(trophy: TmpnameTrophy01): HTMLElement {
  // Ungraded attempts still earn a square -- the wall is evidence of work done,
  // not of work done correctly.
  const grade = trophy.self_grade ?? "ungraded";
  return h("i", { class: `trophy trophy-${grade}`, title: trophy.created_at });
}

export async function tmpnameRefreshTrophyWall01(): Promise<void> {
  const target = tmpnameMountTrophyWall01();
  try {
    const { attempts } = await tmpnameTrophyWall01();
    target.replaceChildren(...attempts.map(square));
  } catch {
    // The wall is ornamental; a failure here must never block practising.
  }
}
