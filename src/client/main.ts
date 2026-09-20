import { h } from "./lib/dom";
import { renderAnswers } from "./views/answers";
import { renderBank } from "./views/bank";
import { renderProblem } from "./views/problem";
import { renderManeuverDrill } from "./views/maneuver-drill";
import { mountTrophyWall, refreshTrophyWall, setTrophyWallVisible } from "./views/trophy-wall";
import type { View } from "./types";

// Single route, so there is no router -- views are just state. Back navigation
// is deliberately absent: a run moves forward only.
function go(view: View): void {
  const root = document.getElementById("app");
  if (!root) return;

  switch (view.name) {
    case "bank":
      setTrophyWallVisible(false);
      void renderBank(root, go);
      break;
    case "problem":
      setTrophyWallVisible(true);
      renderProblem(root, view.runId, view.problems, view.index, go);
      break;
    case "answers":
      setTrophyWallVisible(true);
      void renderAnswers(root, view.runId, go);
      break;
    case "maneuver_drill":
      setTrophyWallVisible(false);
      renderManeuverDrill(root, view.maneuverId, go);
      break;
  }
}

function boot(): void {
  // The wall mounts once and stays behind everything for the life of the page.
  mountTrophyWall();
  void refreshTrophyWall();

  if (!document.getElementById("app")) {
    document.body.append(h("main", { id: "app" }));
  }
  // A drill arrives as a tab of its own, so the run it was launched from is
  // untouched behind it. CLAUDE.md keeps / the only route, which is why this
  // is a query param rather than a path.
  const drilling = Number(
    new URL(window.location.href).searchParams.get("drill"),
  );
  go(drilling ? { name: "maneuver_drill", maneuverId: drilling } : { name: "bank" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
