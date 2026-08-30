import { furtherPractice, gradeAttempt, markForFurtherPractice, revealAnswers } from "../api";
import { formatElapsed, h } from "../lib/dom";
import { renderMathHtml } from "../lib/katex-boot";
import { refreshTrophyWall } from "./trophy-wall";
import type { AnswerRow, SelfGrade, View } from "../types";

const GRADES: SelfGrade[] = ["right", "wrong", "skipped"];

function answerRow(row: AnswerRow): HTMLElement {
  const item = h("li", {});
  let current = row.self_grade;
  let marked = row.marked_for_further_practice === 1;

  const markBox = h("input", { type: "checkbox" });
  markBox.checked = marked;

  const paintMark = () => {
    markBox.checked = marked;
    item.className = marked ? "marked" : "";
  };

  async function setMarked(next: boolean): Promise<void> {
    if (next === marked) return;
    const previous = marked;
    marked = next;
    paintMark();
    try {
      await markForFurtherPractice(row.attempt_id, next);
    } catch {
      marked = previous;
      paintMark();
    }
  }

  const buttons = h("div", { class: "acts" });

  const paintGrade = () => {
    GRADES.forEach((grade, idx) => {
      const child = buttons.children[idx];
      child.className = grade === current ? "grade grade-on" : "grade";
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
            paintGrade();
            try {
              await gradeAttempt(row.attempt_id, grade);
              void refreshTrophyWall();
              // A wrong answer is almost always something to practise again, so
              // it ticks the box for you. Changing the grade afterwards does not
              // untick it -- dropping a problem from the next set stays a choice
              // you make, never one made for you.
              if (grade === "wrong") void setMarked(true);
            } catch {
              current = previous;
              paintGrade();
            }
          },
        },
        [grade],
      ),
    );
  }
  paintGrade();

  buttons.append(
    h("label", { class: "mark" }, [markBox, "marked for further practice"]),
  );
  markBox.addEventListener("change", () => void setMarked(markBox.checked));

  const problemEl = h("div", { class: "problem-body" });
  renderMathHtml(problemEl, row.problem_html);

  // The answer stands alone and always visible -- checking paper against it is
  // the first thing done on this page. The steps are a second, deliberate look,
  // so the walkthrough starts folded.
  const answerEl = h("div", { class: "final-answer" });
  renderMathHtml(answerEl, row.final_answer_html || "—");

  const walkthroughEl = h("div", { class: "walkthrough-body" });
  renderMathHtml(walkthroughEl, row.solution_walkthrough_html);

  paintMark();
  item.append(
    h("div", { class: "meta" }, [
      `#${row.ordinal + 1}`,
      "  ·  ",
      formatElapsed(row.elapsed_ms),
    ]),
    problemEl,
    answerEl,
    h("details", { class: "solution-walkthrough" }, [
      h("summary", {}, ["walkthrough"]),
      walkthroughEl,
    ]),
    buttons,
  );
  return item;
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
  const statusEl = h("div", { id: "out" });

  // With nothing marked this is just another set on the same prompt, which is
  // the behaviour the button had before it learned to read the marks.
  const furtherEl = h(
    "button",
    {
      type: "button",
      id: "go",
      onclick: async () => {
        furtherEl.disabled = true;
        statusEl.textContent = "generating...";
        statusEl.className = "";
        try {
          const set = await furtherPractice(runId);
          if (!set.problems.length) throw new Error("model returned no problems");
          go({ name: "problem", runId: set.run_id, problems: set.problems, index: 0 });
        } catch (err) {
          statusEl.textContent = err instanceof Error ? err.message : String(err);
          statusEl.className = "err";
          furtherEl.disabled = false;
        }
      },
    },
    ["further practice"],
  );

  root.replaceChildren(
    h("h1", {}, ["answers"]),
    h("div", { class: "meta" }, [
      `${rows.length} problems  ·  ${formatElapsed(total)} total`,
    ]),
    h("ul", { id: "saved" }, rows.map(answerRow)),
    h("div", { class: "row" }, [
      furtherEl,
      h("button", { type: "button", onclick: () => go({ name: "compose" }) }, ["home"]),
    ]),
    statusEl,
  );
}
