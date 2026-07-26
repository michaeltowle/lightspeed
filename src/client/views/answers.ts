import { tmpnameGradeAttempt01, tmpnameRevealAnswers01 } from "../api";
import { formatElapsed, h } from "../lib/dom";
import { tmpnameRenderMathHtml01 } from "../lib/katex-boot";
import { tmpnameRefreshTrophyWall01 } from "./trophy-wall";
import type { TmpnameAnswerRow01, TmpnameSelfGrade01, TmpnameView01 } from "../types";

const GRADES: TmpnameSelfGrade01[] = ["right", "wrong", "skipped"];

function gradeRow(row: TmpnameAnswerRow01): HTMLElement {
  const buttons = h("div", { class: "acts" });
  let current = row.self_grade;

  const paint = () => {
    Array.from(buttons.children).forEach((child, idx) => {
      child.className = GRADES[idx] === current ? "grade grade-on" : "grade";
    });
  };

  for (const grade of GRADES) {
    buttons.append(
      h(
        "button",
        {
          type: "button",
          onclick: async () => {
            const previous = current;
            current = grade;
            paint();
            try {
              await tmpnameGradeAttempt01(row.attempt_id, grade);
              void tmpnameRefreshTrophyWall01();
            } catch {
              current = previous;
              paint();
            }
          },
        },
        [grade],
      ),
    );
  }
  paint();

  const problemEl = h("div", { class: "problem-body" });
  tmpnameRenderMathHtml01(problemEl, row.problem_html);
  const answerEl = h("div", { class: "answer-body" });
  tmpnameRenderMathHtml01(answerEl, row.answer_html);

  return h("li", {}, [
    h("div", { class: "meta" }, [
      `#${row.ordinal + 1}`,
      "  ·  ",
      formatElapsed(row.elapsed_ms),
    ]),
    problemEl,
    answerEl,
    buttons,
  ]);
}

export async function tmpnameRenderAnswers01(
  root: HTMLElement,
  runId: number,
  go: (view: TmpnameView01) => void,
): Promise<void> {
  root.replaceChildren(h("div", { id: "out" }, ["loading answers..."]));

  let rows: TmpnameAnswerRow01[];
  try {
    ({ rows } = await tmpnameRevealAnswers01(runId));
  } catch (err) {
    root.replaceChildren(
      h("div", { id: "out", class: "err" }, [
        err instanceof Error ? err.message : String(err),
      ]),
    );
    return;
  }

  const total = rows.reduce((sum, row) => sum + row.elapsed_ms, 0);

  root.replaceChildren(
    h("h1", {}, ["answers"]),
    h("div", { class: "meta" }, [
      `${rows.length} problems  ·  ${formatElapsed(total)} total`,
    ]),
    h("ul", { id: "saved" }, rows.map(gradeRow)),
    h("div", { class: "row" }, [
      h(
        "button",
        { type: "button", id: "go", onclick: () => go({ name: "compose" }) },
        ["new set"],
      ),
    ]),
  );
}
