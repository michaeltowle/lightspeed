import { h } from "./lib/dom";
import { renderAnswers } from "./views/answers";
import { renderGenerators } from "./views/generators";
import { renderProblem } from "./views/problem";
import { mountTrophyWall, refreshTrophyWall, setTrophyWallVisible } from "./views/trophy-wall";
import type { View } from "./types";

// Single route, so there is no router -- views are just state. Back navigation
// is deliberately absent: a run moves forward only.
function go(view: View): void {
  const root = document.getElementById("app");
  if (!root) return;

  switch (view.name) {
    case "generators":
      setTrophyWallVisible(false);
      void renderGenerators(root, go);
      break;
    case "problem":
      setTrophyWallVisible(true);
      renderProblem(
        root,
        view.runId,
        view.requestedCount,
        view.problems,
        view.index,
        go,
      );
      break;
    case "answers":
      setTrophyWallVisible(true);
      void renderAnswers(root, view.runId, go);
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
  go({ name: "generators" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
