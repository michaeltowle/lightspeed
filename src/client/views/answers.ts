import { gradeAttempt, revealAnswers } from "../api";
import { formatElapsed, h } from "../lib/dom";
import { renderMathHtml } from "../lib/katex-boot";
import { refreshTrophyWall } from "./trophy-wall";
import type { AnswerRow, SelfGrade, View } from "../types";

const GRADES: SelfGrade[] = ["right", "wrong", "skipped"];

function gradeRow(row: AnswerRow): HTMLElement {
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
              await gradeAttempt(row.attempt_id, grade);
              void refreshTrophyWall();
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
  renderMathHtml(problemEl, row.problem_html);
  const answerEl = h("div", { class: "answer-body" });
  renderMathHtml(answerEl, row.answer_html);

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

export async function renderAnswers(
  root: HTMLElement,
  runId: number,
  go: (view: View) => void,
): Promise<void> {
  root.replaceChildren(h("div", { id: "out" }, ["loading answers..."]));

  let rows: AnswerRow[];
  try {
    ({ rows } = await revealAnswers(runId));
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
