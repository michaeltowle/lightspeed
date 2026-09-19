import { h } from "./dom";
import { renderMathHtml } from "./katex-boot";
import type { Maneuver } from "../types";

/** Unmarked, got it, missed it. Cycled by clicking the result cell. */
export type ManeuverCredit = "unmarked" | "got" | "missed";

export const nextCredit = (current: ManeuverCredit): ManeuverCredit =>
  current === "unmarked" ? "got" : current === "got" ? "missed" : "unmarked";

const creditClass = (credit: ManeuverCredit) =>
  credit === "got"
    ? "maneuver-result is-got"
    : credit === "missed"
      ? "maneuver-result is-missed"
      : "maneuver-result";

/**
 * The table Mike grades himself against: what the step is, how to get there in
 * words, and what it produces.
 *
 * Two modes, because the same three columns do two jobs. Grading on the answers
 * page: every result is visible and each cell cycles unmarked -> got -> missed.
 * Help on the problem page: the method column is readable and every result
 * starts covered, uncovered one at a time, so one step can be checked without
 * giving up the rest.
 */
export function renderManeuverTable(
  maneuvers: Maneuver[],
  options: {
    mode: "grade" | "help";
    creditOf?: (maneuver: Maneuver) => ManeuverCredit;
    onCycle?: (maneuver: Maneuver, next: ManeuverCredit) => void;
    onDrill?: (maneuver: Maneuver) => void;
  },
): HTMLElement {
  const { mode, creditOf, onCycle, onDrill } = options;

  const body = h("tbody", {}, maneuvers.map((maneuver) => {
    const row = h("tr", { class: "maneuver-row" });

    const resultCell = h("td", { class: "maneuver-result" });
    const paintResult = () => {
      resultCell.className = creditClass(creditOf?.(maneuver) ?? "unmarked");
      renderMathHtml(resultCell, maneuver.result_html);
    };

    if (mode === "grade") {
      paintResult();
      resultCell.addEventListener("click", () => {
        const next = nextCredit(creditOf?.(maneuver) ?? "unmarked");
        onCycle?.(maneuver, next);
        paintResult();
      });
      resultCell.setAttribute("title", "click to cycle: got it, missed it, unmarked");
    } else {
      // Covered until asked for. The result is already on the page, so
      // uncovering is instant -- but nothing was fetched until help was pressed.
      const reveal = h("button", { type: "button" }, ["reveal"]);
      reveal.addEventListener("click", (event) => {
        event.stopPropagation();
        renderMathHtml(resultCell, maneuver.result_html);
      });
      resultCell.append(h("span", { class: "result-veil" }, ["hidden", reveal]));
    }

    row.append(
      h("td", { class: "maneuver-name" }, [
        maneuver.name,
        ...(onDrill
          ? [
              h(
                "button",
                {
                  type: "button",
                  class: "maneuver-drill",
                  title: "drill this maneuver",
                  onclick: (event: Event) => {
                    event.stopPropagation();
                    onDrill(maneuver);
                  },
                },
                ["drill"],
              ),
            ]
          : []),
      ]),
      h("td", { class: "maneuver-method" }, [maneuver.method_text]),
      resultCell,
    );
    return row;
  }));

  return h("table", { class: mode === "help" ? "maneuver-table is-help" : "maneuver-table" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", {}, ["maneuver"]),
        h("th", {}, ["how"]),
        h("th", {}, ["result"]),
      ]),
    ]),
    body,
  ]);
}
