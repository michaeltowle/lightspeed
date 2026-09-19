import {
  listTheBank,
  openPracticeRun,
  renameProblem,
  retagProblem,
  trophyWall,
} from "../api";
import { h } from "../lib/dom";
import { renderMathHtml } from "../lib/katex-boot";
import { parseTagNames, renderAddAssignment } from "./add-assignment";
import { square } from "./trophy-wall";
import { STUDY_CONTEXT_TAG_FIELDS } from "../types";
import type {
  MathPracticeProblem,
  StudyContextTag,
  StudyContextTagField,
  Trophy,
  View,
} from "../types";

// Enough squares to read a streak off, few enough to sit in one cell beside the
// field columns.
const STRIP_LENGTH = 12;

const ROLLING_WEEK_DAYS = 7;

// Both counted in whole days, not elapsed time: something worked on Monday
// evening and something worked on Monday morning are the same number of days
// ago on Thursday, and neither should tip a row over on the hour.
const GONE_COLD_AFTER_DAYS = 7;
const GOING_COLD_AFTER_DAYS = 2;

// Select, label, name, four fields, strip, menu.
const TABLE_COLUMN_COUNT = 9;

const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const catalogueListId = (field: StudyContextTagField) => `tag-catalogue-${field}`;

// Filing a problem under a class and then working that class is a week's habit,
// not a visit's, so the filter outlives the tab. Kept per-device rather than on
// the server: the phone practises and the laptop authors, and they are rarely
// pointed at the same class.
const STANDING_STUDY_CONTEXT_TAG_FILTER_KEY = "lightspeed.standing-study-context-tag-filter";

function readStandingStudyContextTagFilter(): number | null {
  try {
    const raw = localStorage.getItem(STANDING_STUDY_CONTEXT_TAG_FILTER_KEY);
    const id = raw === null ? NaN : Number(raw);
    return Number.isInteger(id) ? id : null;
  } catch {
    // Storage walled off. The filter still works, it just stops being sticky.
    return null;
  }
}

function writeStandingStudyContextTagFilter(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(STANDING_STUDY_CONTEXT_TAG_FILTER_KEY);
    else localStorage.setItem(STANDING_STUDY_CONTEXT_TAG_FILTER_KEY, String(id));
  } catch {
    // As above.
  }
}

// One menu open at a time, closed by the next click anywhere. Bound once at
// module scope -- the table repaints on every rename, and a listener attached
// per render would stack a copy each time.
let closeOpenMenu: (() => void) | null = null;
document.addEventListener("click", () => closeOpenMenu?.());

/** The most recent graded attempt against a problem, and the squares to show. */
function standingOf(trophies: Trophy[] | undefined): {
  lastWorkedAt: string | null;
  strip: Trophy[];
} {
  const list = trophies ?? [];
  return {
    // The worker sends them oldest first, so the last one is the most recent.
    lastWorkedAt: list.length ? list[list.length - 1].created_at : null,
    strip: list.slice(-STRIP_LENGTH),
  };
}

/** Which calendar day a timestamp fell on *here*, which is the only day Mike has. */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Whole local days from one date to another, with the clock discarded.
 *
 * Rounded rather than floored because a day is not always 86400 seconds: across
 * a daylight-saving boundary one of them is an hour short or an hour long, and
 * truncating would quietly lose or gain a day.
 */
function daysBetween(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

/**
 * How much was worked on each of the last seven days, today at the top.
 *
 * Counted off the same graded attempts the trophy squares are drawn from, which
 * the page has already fetched -- so this costs no round trip of its own. It
 * measures problems *answered*: back out of a run before the answers page and
 * nothing here moves, which is the same bargain the wall makes.
 *
 * Each bar is split by class, with a key beneath naming the colours. The fills
 * are the ledger's own rather than the chips': chip hues sit too close together
 * to tell apart in a sliver of bar, and their inks and grounds are too heavy and
 * too faint respectively.
 */
function renderRollingWeekPracticeLedger(
  trophies: Trophy[],
  problems: MathPracticeProblem[],
  tagCatalogue: StudyContextTag[],
): HTMLElement {
  // Creation order -- ids only grow -- so a new class takes the next colour
  // instead of repainting the ones already on screen.
  const classTags = tagCatalogue
    .filter((tag) => tag.field === "class")
    .sort((a, b) => a.id - b.id);

  // Six class fills in the stylesheet. A seventh class wraps round, which only
  // collides if two classes six apart are both worked in the same week.
  const fillOf = (tag: StudyContextTag | null) =>
    tag
      ? `var(--ledger-class-fill-${(classTags.indexOf(tag) % 6) + 1})`
      : "var(--ledger-no-class-fill)";
  const classesOf = new Map(
    problems.map((p) => [
      p.id,
      classTags.filter((tag) => p.study_context_tag_ids.includes(tag.id)),
    ]),
  );

  // Keyed by class id, null for work on a problem filed under no class. That
  // work keeps a grey segment of its own: leaving it out would make a day look
  // lighter than it was. A problem in two classes splits its count between them
  // rather than counting twice, so the segments still add up to the day.
  const perDay = new Map<string, { count: number; byClass: Map<number | null, number> }>();
  for (const trophy of trophies) {
    const when = new Date(trophy.created_at);
    if (isNaN(when.getTime())) continue;
    const key = localDayKey(when);
    const tally = perDay.get(key) ?? { count: 0, byClass: new Map() };
    perDay.set(key, tally);
    tally.count += 1;
    const classes = classesOf.get(trophy.math_practice_problem_id) ?? [];
    if (!classes.length) tally.byClass.set(null, (tally.byClass.get(null) ?? 0) + 1);
    for (const tag of classes) {
      tally.byClass.set(tag.id, (tally.byClass.get(tag.id) ?? 0) + 1 / classes.length);
    }
  }

  // Classes in colour order, classless last, the same on every day -- so a
  // colour sits at the same end of the bar all week.
  const segmentOrder: (StudyContextTag | null)[] = [...classTags, null];

  // Bucketed in local time rather than UTC: a run worked at 9pm belongs to that
  // evening, not to the next morning in Greenwich.
  const today = new Date();
  const days = Array.from({ length: ROLLING_WEEK_DAYS }, (_, back) => {
    const day = new Date(today);
    day.setDate(today.getDate() - back);
    const tally = perDay.get(localDayKey(day));
    const segments = segmentOrder
      .map((tag) => ({ tag, share: tally?.byClass.get(tag?.id ?? null) ?? 0 }))
      .filter((segment) => segment.share > 0);
    return {
      isToday: back === 0,
      label: back === 0 ? "today" : WEEKDAY_NAMES[day.getDay()],
      count: tally?.count ?? 0,
      segments,
    };
  });

  const busiest = Math.max(1, ...days.map((day) => day.count));

  // Only classes the week holds -- a key for a class not worked since last month
  // names a colour that is nowhere on screen. Grey goes unlabelled: it is the
  // one fill that is not a colour, so it needs no name.
  const inKey = classTags.filter((tag) =>
    days.some((day) => day.segments.some((s) => s.tag === tag)),
  );

  return h("aside", { class: "rolling-week-practice-ledger" }, [
    h("div", { class: "ledger-title" }, ["last 7 days"]),
    ...days.map((day) =>
      h(
        "div",
        {
          class: day.isToday ? "ledger-day is-today" : "ledger-day",
          // On the row rather than the segments: a bar this thin is hard to aim at.
          title: day.segments
            .map((s) => `${s.tag?.name ?? "no class"}: ${Math.round(s.share)}`)
            .join(" · "),
        },
        [
          h("span", { class: "day-name" }, [day.label]),
          h("span", { class: "day-track" }, [
            h(
              "span",
              {
                class: "day-bar",
                style: `width:${Math.round((day.count / busiest) * 100)}%`,
              },
              day.segments.map((s) =>
                h("span", { style: `flex-grow:${s.share};background:${fillOf(s.tag)}` }),
              ),
            ),
          ]),
          h("span", { class: "day-count" }, [String(day.count)]),
        ],
      ),
    ),
    ...(inKey.length
      ? [
          h(
            "div",
            { class: "ledger-key" },
            inKey.map((tag) =>
              h("span", { class: "key-entry" }, [
                h("span", { class: "key-swatch", style: `background:${fillOf(tag)}` }),
                tag.name,
              ]),
            ),
          ),
        ]
      : []),
  ]);
}

function buildBankTable(body: HTMLElement): HTMLElement {
  return h("table", { class: "bank-table" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", { class: "col-select" }, []),
        h("th", { class: "col-label" }, ["no."]),
        h("th", {}, ["problem"]),
        ...STUDY_CONTEXT_TAG_FIELDS.map((field) =>
          h("th", { class: `col-field-${field}` }, [field]),
        ),
        h("th", { class: "col-strip" }, []),
        h("th", { class: "col-menu" }, []),
      ]),
    ]),
    body,
  ]);
}

export async function renderBank(
  root: HTMLElement,
  go: (view: View) => void,
): Promise<void> {
  root.replaceChildren(h("div", { id: "out" }, ["loading..."]));

  let problems: MathPracticeProblem[];
  let tagCatalogue: StudyContextTag[];
  let trophies: Trophy[];
  try {
    // Both in flight together: neither depends on the other, and the trophy
    // payload is what the strips and the ledger are built from.
    const [listed, walled] = await Promise.all([listTheBank(), trophyWall()]);
    problems = listed.problems;
    tagCatalogue = listed.study_context_tags;
    trophies = walled.attempts;
  } catch (err) {
    root.replaceChildren(
      h("div", { id: "out", class: "err" }, [
        err instanceof Error ? err.message : String(err),
      ]),
    );
    return;
  }

  const byProblem = new Map<number, Trophy[]>();
  for (const trophy of trophies) {
    const list = byProblem.get(trophy.math_practice_problem_id);
    if (list) list.push(trophy);
    else byProblem.set(trophy.math_practice_problem_id, [trophy]);
  }

  // Several problems are practised at once now, so the bank is a list of
  // checkboxes and the button beneath acts on every one that is ticked.
  const ticked = new Set<number>();

  // A tag retired since the last visit cannot go on being the filter: it would
  // empty the table with no lit chip to explain why.
  const remembered = readStandingStudyContextTagFilter();
  let filterTagId: number | null =
    remembered !== null && tagCatalogue.some((t) => t.id === remembered) ? remembered : null;
  if (filterTagId !== remembered) writeStandingStudyContextTagFilter(filterTagId);

  const setFilterTagId = (id: number | null): void => {
    filterTagId = id;
    writeStandingStudyContextTagFilter(id);
  };

  const rowsById = new Map<number, { row: HTMLElement; box: HTMLInputElement }>();

  const bodyEl = h("tbody");
  const tableEl = buildBankTable(bodyEl);
  const emptyEl = h("div", { class: "bank-note" }, ["nothing filed under that"]);
  const filterEl = h("div", { class: "study-context-tag-filter" });

  // One list per field: completing a source against the catalogue of classes
  // would offer names that cannot belong there.
  const catalogueEls = new Map<StudyContextTagField, HTMLElement>(
    STUDY_CONTEXT_TAG_FIELDS.map((field) => [
      field,
      h("datalist", { id: catalogueListId(field) }),
    ]),
  );

  let ledgerEl = renderRollingWeekPracticeLedger(trophies, problems, tagCatalogue);

  // ---- the practice control, one for the whole bank ------------------------
  const practiceEl = h("button", { type: "button", class: "practice", disabled: true }, [
    "practice",
  ]);
  const tickAllEl = h("button", { type: "button" }, ["tick all shown"]);
  const untickAllEl = h("button", { type: "button" }, ["clear"]);
  const practiceStatusEl = h("div", { class: "bank-note" });

  const setPracticeStatus = (text: string, isError = false) => {
    practiceStatusEl.textContent = text;
    practiceStatusEl.className = isError ? "bank-note err" : "bank-note";
  };

  practiceEl.addEventListener("click", async () => {
    if (!ticked.size) return;
    practiceEl.disabled = true;
    setPracticeStatus("opening...");
    try {
      // Served exactly, so there is no model call here at all -- the wait is a
      // round trip and nothing more.
      const order = shownProblems().filter((p) => ticked.has(p.id)).map((p) => p.id);
      const run = await openPracticeRun(order);
      if (!run.problems.length) throw new Error("nothing to serve");
      go({ name: "problem", runId: run.run_id, problems: run.problems, index: 0 });
    } catch (err) {
      setPracticeStatus(err instanceof Error ? err.message : String(err), true);
      practiceEl.disabled = false;
    }
  });

  function paintTickState(): void {
    for (const [id, entry] of rowsById) {
      const on = ticked.has(id);
      entry.row.classList.toggle("is-ticked", on);
      entry.box.checked = on;
    }
    practiceEl.disabled = ticked.size === 0;
    setPracticeStatus(ticked.size ? `${ticked.size} ticked` : "");
  }

  const setTicked = (id: number, on: boolean): void => {
    if (on) ticked.add(id);
    else ticked.delete(id);
    paintTickState();
  };

  // Select-by-tag, which is the whole point of filtering first: narrow to
  // "6801 HW3", tick the lot, run.
  tickAllEl.addEventListener("click", () => {
    for (const problem of shownProblems()) ticked.add(problem.id);
    paintTickState();
  });
  untickAllEl.addEventListener("click", () => {
    ticked.clear();
    paintTickState();
  });

  // ---- tags ----------------------------------------------------------------
  const tagById = () => new Map(tagCatalogue.map((tag) => [tag.id, tag]));

  function tagsOf(
    problem: MathPracticeProblem,
    field: StudyContextTagField,
  ): StudyContextTag[] {
    const byId = tagById();
    return problem.study_context_tag_ids
      .map((id) => byId.get(id))
      .filter((tag): tag is StudyContextTag => Boolean(tag) && tag!.field === field)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const chipOf = (tag: StudyContextTag, extra = "") =>
    h("span", { class: `study-context-tag-chip chip-color-${tag.chip_color_ordinal}${extra}` }, [
      tag.name,
    ]);

  function paintTagCatalogue(): void {
    for (const field of STUDY_CONTEXT_TAG_FIELDS) {
      catalogueEls
        .get(field)!
        .replaceChildren(
          ...tagCatalogue
            .filter((tag) => tag.field === field)
            .map((tag) => h("option", { value: tag.name })),
        );
    }

    // Grouped by field, so a filter row of two dozen chips still says what each
    // of them is filtering on.
    const groups: (Node | string)[] = [];
    for (const field of STUDY_CONTEXT_TAG_FIELDS) {
      const inField = tagCatalogue.filter((tag) => tag.field === field);
      if (!inField.length) continue;
      groups.push(h("span", { class: "field-label" }, [field]));
      for (const tag of inField) {
        groups.push(
          h(
            "button",
            {
              type: "button",
              class: `study-context-tag-chip chip-color-${tag.chip_color_ordinal}${
                tag.id === filterTagId ? " is-on" : ""
              }`,
              onclick: () => {
                // A second click on the lit chip clears the filter -- there is
                // no "all" chip to hunt for.
                setFilterTagId(filterTagId === tag.id ? null : tag.id);
                paintTagCatalogue();
                paintAll();
              },
            },
            [tag.name],
          ),
        );
      }
    }
    filterEl.replaceChildren(...groups);
    filterEl.hidden = !groups.length;
  }

  function shownIn(list: MathPracticeProblem[]): MathPracticeProblem[] {
    return filterTagId === null
      ? list
      : list.filter((p) => p.study_context_tag_ids.includes(filterTagId!));
  }

  /**
   * What the active table is currently showing: unvaried originals only, in the
   * order they are painted. Variants of a problem are reached by expanding it
   * rather than listed beside it, so the bank stays as long as what was put in.
   */
  function shownProblems(): MathPracticeProblem[] {
    return sortForBank(
      shownIn(
        problems.filter(
          (p) =>
            !p.archived_at &&
            p.parent_problem_varied_from === null &&
            p.the_maneuver_it_was_isolated_from === null,
        ),
      ),
    );
  }

  // Never-worked first -- those are the problems in the bank with no practice
  // against them, which is exactly what this page is for noticing. Everything
  // else by how recently it was touched.
  //
  // Within a group, oldest id first, which is the order they were read off the
  // page: 2.1(a) before 2.11(b). This is the order the work is done in, and
  // the table's order is the run's order -- what is ticked is served in the
  // order it is listed -- so a set started from here opens where the homework
  // opens rather than at its last question.
  function sortForBank(list: MathPracticeProblem[]): MathPracticeProblem[] {
    return [...list].sort((a, b) => {
      const aAt = standingOf(byProblem.get(a.id)).lastWorkedAt;
      const bAt = standingOf(byProblem.get(b.id)).lastWorkedAt;
      if (!aAt && !bAt) return a.id - b.id;
      if (!aAt) return -1;
      if (!bAt) return 1;
      return bAt < aAt ? -1 : bAt > aAt ? 1 : a.id - b.id;
    });
  }

  /** Repaint the table from the local list. */
  function paintAll(): void {
    const active = shownProblems();

    rowsById.clear();
    bodyEl.replaceChildren(...active.map(bankRow));

    tableEl.hidden = !active.length;
    emptyEl.hidden = Boolean(active.length) || filterTagId === null;

    // Recoloured with the table, since a retag can move a problem between classes.
    const nextLedgerEl = renderRollingWeekPracticeLedger(trophies, problems, tagCatalogue);
    ledgerEl.replaceWith(nextLedgerEl);
    ledgerEl = nextLedgerEl;

    // A tick the filter has just hidden is not a tick any more.
    for (const id of [...ticked]) if (!rowsById.has(id)) ticked.delete(id);
    paintTickState();
  }

  function bankRow(problem: MathPracticeProblem): HTMLElement {
    const row = h("tr", { class: "bank-row" });
    const standing = standingOf(byProblem.get(problem.id));

    // Never practised counts as gone cold: it is at least as far from being
    // worked as something last touched a fortnight ago.
    const daysSinceWorked = standing.lastWorkedAt
      ? daysBetween(new Date(standing.lastWorkedAt), new Date())
      : null;
    // An archived problem is not meant to be kept warm. Nothing in the UI can
    // archive one now that the tab is gone, but the column outlives it.
    if (!problem.archived_at) {
      if (daysSinceWorked === null || daysSinceWorked >= GONE_COLD_AFTER_DAYS) {
        row.classList.add("is-gone-cold");
      } else if (daysSinceWorked > GOING_COLD_AFTER_DAYS) {
        row.classList.add("is-going-cold");
      }
    }

    const boxEl = h("input", { type: "checkbox", "aria-label": problem.name });
    boxEl.addEventListener("click", (event) => {
      event.stopPropagation();
      setTicked(problem.id, boxEl.checked);
    });

    const nameCell = h("td", { class: "problem-name", title: problem.statement_html }, [
      problem.name,
      // A problem with no table has nothing to reveal at the end of a run, so
      // the bank says so rather than letting it surprise you there.
      ...(problem.broken_into_maneuvers_at
        ? []
        : [h("span", { class: "awaiting-break" }, ["  · no table yet"])]),
    ]);
    const menuCell = h("td", { class: "col-menu" });

    rowsById.set(problem.id, { row, box: boxEl });

    // The row is the tick target. Anything inside it that does something else
    // stops the click before it gets here.
    row.addEventListener("click", () => setTicked(problem.id, !ticked.has(problem.id)));

    // ---- rename ------------------------------------------------------------
    function beginRename(): void {
      const input = h("input", { class: "problem-name-input", value: problem.name });
      nameCell.replaceChildren(input);
      input.focus();
      input.select();

      let settled = false;
      const finish = async (save: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        const next = input.value.replace(/\s+/g, " ").trim().slice(0, 64);
        const keep = save && Boolean(next) && next !== problem.name;
        nameCell.replaceChildren(keep ? next : problem.name);
        if (!keep) return;

        const previous = problem.name;
        problem.name = next;
        try {
          await renameProblem(problem.id, next);
        } catch {
          problem.name = previous;
          nameCell.replaceChildren(previous);
        }
      };

      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("keydown", (event) => {
        const key = (event as KeyboardEvent).key;
        if (key === "Enter") {
          event.preventDefault();
          void finish(true);
        } else if (key === "Escape") {
          void finish(false);
        }
      });
      input.addEventListener("blur", () => void finish(true));
    }

    // ---- one cell per field ------------------------------------------------
    function fieldCell(field: StudyContextTagField): HTMLElement {
      const cell = h("td", { class: `study-context-tag-cell col-field-${field}` });

      function paint(): void {
        const tags = tagsOf(problem, field);
        cell.replaceChildren(
          ...(tags.length
            ? tags.map((tag) => chipOf(tag))
            : [h("span", { class: "study-context-tag-empty" }, ["+"])]),
        );
      }

      function beginEdit(): void {
        const before = tagsOf(problem, field).map((tag) => tag.name);
        const input = h("input", {
          class: "study-context-tag-input",
          list: catalogueListId(field),
          value: before.join(", "),
        });
        cell.replaceChildren(input);
        input.focus();
        input.select();

        let settled = false;
        const finish = async (save: boolean): Promise<void> => {
          if (settled) return;
          settled = true;
          const next = parseTagNames(input.value);
          paint();
          const unchanged =
            next.length === before.length && next.every((n, i) => n === before[i]);
          if (!save || unchanged) return;

          try {
            const result = await retagProblem(problem.id, field, next);
            tagCatalogue = result.study_context_tags;
            problem.study_context_tag_ids = result.study_context_tag_ids;
            paintTagCatalogue();
            paintAll();
          } catch (err) {
            setPracticeStatus(err instanceof Error ? err.message : String(err), true);
            paint();
          }
        };

        input.addEventListener("click", (event) => event.stopPropagation());
        input.addEventListener("keydown", (event) => {
          const key = (event as KeyboardEvent).key;
          if (key === "Enter") {
            event.preventDefault();
            void finish(true);
          } else if (key === "Escape") {
            void finish(false);
          }
        });
        input.addEventListener("blur", () => void finish(true));
      }

      paint();
      cell.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!cell.querySelector("input")) beginEdit();
      });
      return cell;
    }

    // ---- look at it --------------------------------------------------------
    // The statement, the screenshots it was read off, and what minted it. A
    // row of a table is no place to read a maths problem, and identifying one
    // is exactly what the bank is for.
    const hasScreenshot = () => problem.screenshot_of_record_ids.length > 0;

    /**
     * The problem as written, or the page it was read off -- one or the other,
     * never both at once. They answer different questions ("is this the one I
     * mean?" against "what did the book actually say?") and a row is a poor
     * place to scroll, so asking for one replaces the other rather than
     * stacking underneath it.
     */
    function openDetail(showing: "text" | "screenshot"): void {
      const open = row.nextElementSibling as HTMLElement | null;
      if (open?.classList.contains("detail-row")) open.remove();

      const shown: (Node | string)[] = [];
      if (showing === "text") {
        const statementEl = h("div", { class: "problem-body" });
        renderMathHtml(statementEl, problem.statement_html);
        shown.push(statementEl);
        if (problem.text_that_minted_this_problem) {
          shown.push(
            h("div", { class: "bank-note" }, [
              `minted with: ${problem.text_that_minted_this_problem}`,
            ]),
          );
        }
      } else {
        shown.push(
          h(
            "ul",
            { class: "shots" },
            problem.screenshot_of_record_ids.map((id) =>
              h("li", {}, [
                h("a", { href: `/?shot=${id}`, target: "_blank", rel: "noreferrer" }, [
                  h("img", { src: `/?shot=${id}`, alt: "" }),
                ]),
              ]),
            ),
          ),
        );
      }

      const detailRow = h("tr", { class: "detail-row" }, [
        h("td", { colspan: TABLE_COLUMN_COUNT }, [
          ...shown,
          h("div", { class: "acts" }, [
            h(
              "button",
              { type: "button", class: "grade", onclick: () => detailRow.remove() },
              ["close"],
            ),
          ]),
        ]),
      ]);
      detailRow.addEventListener("click", (event) => event.stopPropagation());
      row.after(detailRow);
    }

    // ---- menu --------------------------------------------------------------
    function openMenu(): void {
      closeOpenMenu?.();
      const item = (label: string, act: () => void, enabled = true) =>
        h("button", { type: "button", disabled: !enabled, onclick: act }, [label]);

      const menu = h("div", { class: "row-menu" }, [
        item("view problem text", () => openDetail("text")),
        // A problem written to order was never read off anything, so there is
        // nothing to show it against.
        item("view screenshot", () => openDetail("screenshot"), hasScreenshot()),
        item("rename", beginRename),
      ]);
      menuCell.append(menu);
      closeOpenMenu = () => {
        menu.remove();
        closeOpenMenu = null;
      };
    }

    menuCell.append(
      h(
        "button",
        {
          type: "button",
          class: "row-menu-open",
          title: "options",
          "aria-label": "options",
          onclick: (event: Event) => {
            // Otherwise this same click bubbles to the document listener that
            // closes menus, and the menu shuts the instant it opens.
            event.stopPropagation();
            openMenu();
          },
        },
        ["⋯"],
      ),
    );

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu();
    });

    row.append(
      h("td", { class: "col-select" }, [boxEl]),
      h("td", { class: "col-label" }, [problem.textbook_problem_number_label ?? ""]),
      nameCell,
      ...STUDY_CONTEXT_TAG_FIELDS.map(fieldCell),
      h("td", { class: "col-strip" }, [
        h("span", { class: "problem-strip" }, standing.strip.map(square)),
      ]),
      menuCell,
    );
    return row;
  }

  // ---- tabs ----------------------------------------------------------------
  const addAssignment = renderAddAssignment(
    // New problems land in the bank, so the page is rebuilt rather than patched.
    () => void renderBank(root, go),
    () => tagCatalogue,
    go,
  );
  const addAssignmentPane = h("div", {}, [addAssignment.el]);
  const practiceLaunchEl = h("div", { class: "row practice-launch-control" }, [
    practiceEl,
    tickAllEl,
    untickAllEl,
  ]);
  const bankPane = h("div", {}, [filterEl, tableEl, emptyEl, practiceLaunchEl, practiceStatusEl]);

  // The ticks are dropped on the way back in, or the practice button would act
  // on a selection made before something was added or retagged.
  const showList = () => {
    ticked.clear();
    paintTickState();
  };

  const tabs: { label: string; pane: HTMLElement; onShow?: () => void }[] = [
    { label: "bank", pane: bankPane, onShow: showList },
    // Classes created in the bank while this form sat hidden.
    {
      label: "add assignment",
      pane: addAssignmentPane,
      onShow: addAssignment.refreshTagChips,
    },
  ];
  const tabEls = tabs.map(({ label }) => h("button", { type: "button", class: "tab" }, [label]));

  function showTab(index: number): void {
    tabs.forEach(({ pane }, i) => {
      pane.hidden = i !== index;
      tabEls[i].classList.toggle("is-on", i === index);
    });
    tabs[index].onShow?.();
  }
  tabEls.forEach((el, i) => el.addEventListener("click", () => showTab(i)));

  paintTagCatalogue();
  paintAll();
  // The bank opens: most visits are to pick something to practise, not to put
  // something new in.
  showTab(0);

  root.replaceChildren(
    ledgerEl,
    h("div", { class: "tab-strip" }, tabEls),
    bankPane,
    addAssignmentPane,
    ...catalogueEls.values(),
    h("div", { class: "lightspeed-motto-line" }, ["limitations are in the mind"]),
  );
}
