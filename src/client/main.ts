import { h } from "./lib/dom";
import { renderAnswers } from "./views/answers";
import { renderBank } from "./views/bank";
import { renderContinuousScrollPracticeRun } from "./views/continuous-scroll-practice-run";
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
    case "continuous_scroll_practice_run":
      setTrophyWallVisible(true);
      renderContinuousScrollPracticeRun(root, view.runId, view.problems, go);
      // Views swap in place, so the run would open wherever the bank was
      // scrolled to -- the bottom, since that is where practice is pressed.
      window.scrollTo(0, 0);
      break;
    case "answers":
      setTrophyWallVisible(true);
      void renderAnswers(root, view.runId, go, view.msSpentPaused ?? 0);
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
  go({ name: "bank" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
