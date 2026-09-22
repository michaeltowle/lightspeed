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
    onCycle?: (maneuver: Maneuver, next: ManeuverCredit) => void | Promise<void>;
  },
): HTMLElement {
  const { mode, creditOf, onCycle } = options;

  // One click can change the credit on rows nobody clicked -- getting the last
  // maneuver is getting the whole problem -- and a click that fails to save
  // changes none of them. So the table repaints whole, never cell by cell.
  const paints: Array<() => void> = [];
  const repaint = () => {
    for (const paint of paints) paint();
  };

  const body = h("tbody", {}, maneuvers.map((maneuver) => {
    const row = h("tr", { class: "maneuver-row" });

    const resultCell = h("td", { class: "maneuver-result" });
    // The result lives in a span of its own so that repainting it -- or
    // uncovering it -- cannot take the button beside it with it.
    const valueEl = h("span", { class: "maneuver-result-value" });

    const paintResult = () => {
      resultCell.className = creditClass(creditOf?.(maneuver) ?? "unmarked");
      renderMathHtml(valueEl, maneuver.result_html);
    };

    if (mode === "grade") {
      paints.push(paintResult);
      paintResult();
      resultCell.append(valueEl);
      // Without a handler the table is only being looked at -- the bank shows
      // a solution this way -- so a click has nothing to cycle.
      if (onCycle) {
        resultCell.addEventListener("click", () => {
          const next = nextCredit(creditOf?.(maneuver) ?? "unmarked");
          // Painted twice: once on the credit the handler sets straight away,
          // so the click lands under the finger, and again once the worker has
          // had its say, so what is on screen is what was saved.
          void Promise.resolve(onCycle(maneuver, next)).then(repaint, repaint);
          repaint();
        });
        resultCell.setAttribute("title", "click to cycle: got it, missed it, unmarked");
      }
    } else {
      // Covered until asked for. The result is already on the page, so
      // uncovering is instant -- but nothing was fetched until help was pressed.
      // Revealing retires its own button.
      const reveal = h("button", { type: "button" }, ["reveal"]);
      reveal.addEventListener("click", (event) => {
        event.stopPropagation();
        renderMathHtml(valueEl, maneuver.result_html);
        reveal.remove();
      });
      resultCell.append(
        valueEl,
        h("span", { class: "maneuver-result-controls" }, [reveal]),
      );
    }

    // The method goes through the same renderer as the result. Whether it may
    // carry mathematics is the instructions' call, not the table's: plain
    // prose comes through unchanged, and maths renders if they allow it.
    const methodCell = h("td", { class: "maneuver-method" });
    renderMathHtml(methodCell, maneuver.method_text);

    row.append(h("td", { class: "maneuver-name" }, [maneuver.name]), methodCell, resultCell);
    return row;
  }));

  const tableClass =
    mode === "help" ? "maneuver-table is-help" : onCycle ? "maneuver-table" : "maneuver-table is-view";
  return h("table", { class: tableClass }, [
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
