import { h } from "./lib/dom";
import { tmpnameRenderAnswers01 } from "./views/answers";
import { tmpnameRenderCompose01 } from "./views/compose";
import { tmpnameRenderProblem01 } from "./views/problem";
import { tmpnameMountTrophyWall01, tmpnameRefreshTrophyWall01 } from "./views/trophy-wall";
import type { TmpnameView01 } from "./types";

// Single route, so there is no router -- views are just state. Back navigation
// is deliberately absent: a run moves forward only.
function go(view: TmpnameView01): void {
  const root = document.getElementById("app");
  if (!root) return;

  switch (view.name) {
    case "compose":
      tmpnameRenderCompose01(root, go);
      break;
    case "problem":
      tmpnameRenderProblem01(root, view.runId, view.problems, view.index, go);
      break;
    case "answers":
      void tmpnameRenderAnswers01(root, view.runId, go);
      break;
  }
}

function boot(): void {
  // The wall mounts once and stays behind everything for the life of the page.
  tmpnameMountTrophyWall01();
  void tmpnameRefreshTrophyWall01();

  if (!document.getElementById("app")) {
    document.body.append(h("main", { id: "app" }));
  }
  go({ name: "compose" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
