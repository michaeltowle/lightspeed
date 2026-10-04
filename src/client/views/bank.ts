import {
  deleteProblem,
  solveStepByStep,
  listTheBank,
  openPracticeRun,
  renameStudyContextTag,
  retagProblems,
  peekAtManeuvers,
  renameProblem,
  retagProblem,
  trophyWall,
} from "../api";
import { h } from "../lib/dom";
import { renderMathHtml } from "../lib/katex-boot";
import { renderManeuverTable } from "../lib/maneuver-table";
import { renderReSolveControls } from "../lib/re-solve";
import { parseTagNames, renderAddAssignment } from "./add-assignment";
import { renderFreeGenerate } from "./free-generate";
import { renderEditablePerJobInstructionsToLlm } from "./editable-per-job-instructions-to-llm";
import { STUDY_CONTEXT_TAG_FIELDS } from "../types";
import type {
  MathPracticeProblem,
  StudyContextTag,
  StudyContextTagField,
  Trophy,
  View,
} from "../types";

const ROLLING_WEEK_DAYS = 7;

// Both counted in whole days, not elapsed time: something worked on Monday
// evening and something worked on Monday morning are the same number of days
// ago on Thursday, and neither should tip a row over on the hour.
const GONE_COLD_AFTER_DAYS = 7;
const GOING_COLD_AFTER_DAYS = 2;

// Every field gets a column but assignment: the rows are grouped under their
// assignment, so a column of it would only repeat the heading above.
const TABLE_TAG_FIELDS = STUDY_CONTEXT_TAG_FIELDS.filter((field) => field !== "assignment");

// select, label, problem, the tag fields, credit, last, streak, speed, flags,
// why, menu. Derived so a field added or dropped cannot leave the detail row
// spanning the wrong width.
const TABLE_COLUMN_COUNT = 10 + TABLE_TAG_FIELDS.length;


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

function readStandingStudyContextTagFilter(): BankTabKey | null {
  try {
    const raw = localStorage.getItem(STANDING_STUDY_CONTEXT_TAG_FILTER_KEY);
    if (raw === "generated") return raw;
    const id = raw === null ? NaN : Number(raw);
    return Number.isInteger(id) ? id : null;
  } catch {
    // Storage walled off. The filter still works, it just stops being sticky.
    return null;
  }
}

function writeStandingStudyContextTagFilter(key: BankTabKey): void {
  try {
    localStorage.setItem(STANDING_STUDY_CONTEXT_TAG_FILTER_KEY, String(key));
  } catch {
    // As above.
  }
}

// Which assignment groups are shut, per tab. Studying for one exam is a
// fortnight's habit, so shutting what does not bear on it has to outlive the
// visit. The closed ones are stored rather than the open ones, so a homework
// added since arrives open instead of hidden.
//
// Keyed by tab as well as tag: a tag is unique on (field, name), so the
// Homework 1 that 6801 and 6950 both show is one row, and shutting it in one
// class must not shut it in the other.
const CLOSED_ASSIGNMENT_GROUPS_KEY = "lightspeed.closed-assignment-groups";

function readClosedAssignmentGroups(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(CLOSED_ASSIGNMENT_GROUPS_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    // Storage walled off, or written by something else. Everything opens.
    return new Set();
  }
}

function writeClosedAssignmentGroups(closed: Set<string>): void {
  try {
    localStorage.setItem(CLOSED_ASSIGNMENT_GROUPS_KEY, JSON.stringify([...closed]));
  } catch {
    // As above.
  }
}

// One menu open at a time, closed by the next click anywhere. Bound once at
// module scope -- the table repaints on every rename, and a listener attached
// per render would stack a copy each time.
let closeOpenMenu: (() => void) | null = null;
document.addEventListener("click", () => closeOpenMenu?.());

// The statement, typeset, on hovering a problem's name. A title attribute
// can only hold plain text, so it showed the model's HTML and LaTeX as
// source. One card for the whole page, on the body and fixed, so no table
// cell has to hold it and a repaint of the table can't strand a copy.
const bankRowStatementPeekCard = h("div", {
  class: "problem-body bank-row-statement-peek-card",
  hidden: true,
});
document.body.append(bankRowStatementPeekCard);
let bankRowStatementPeekCardTimer: number | undefined;

function hideBankRowStatementPeekCard(): void {
  window.clearTimeout(bankRowStatementPeekCardTimer);
  bankRowStatementPeekCard.hidden = true;
}
document.addEventListener("scroll", hideBankRowStatementPeekCard, true);

function showBankRowStatementPeekCard(anchor: HTMLElement, statementHtml: string): void {
  window.clearTimeout(bankRowStatementPeekCardTimer);
  // A short wait, as a native tooltip has, so sweeping the pointer down the
  // table doesn't flash a card at every row it crosses.
  bankRowStatementPeekCardTimer = window.setTimeout(() => {
    // The name may have gone into rename, or the table repainted, while waiting.
    if (!anchor.isConnected || anchor.querySelector("input")) return;
    renderMathHtml(bankRowStatementPeekCard, statementHtml);
    bankRowStatementPeekCard.hidden = false;

    const gap = 6;
    const cell = anchor.getBoundingClientRect();
    const card = bankRowStatementPeekCard.getBoundingClientRect();
    // Under the name, unless that runs off the bottom and there is more room above.
    const fitsBelow = cell.bottom + gap + card.height <= window.innerHeight;
    const top =
      fitsBelow || cell.top < window.innerHeight - cell.bottom
        ? cell.bottom + gap
        : cell.top - gap - card.height;
    const left = Math.min(cell.left, window.innerWidth - card.width - gap);
    bankRowStatementPeekCard.style.top = `${Math.max(gap, top)}px`;
    bankRowStatementPeekCard.style.left = `${Math.max(gap, left)}px`;
  }, 350);
}

/** The most recent graded attempt against a problem, and the squares to show. */
/**
 * Full marks on one attempt.
 *
 * Attempts graded before the fraction existed have no counts, so those fall
 * back to the outcome they rolled up to at the time. Without that every row's
 * streak would start from zero the day the columns landed.
 */
function wasFullMarks(trophy: Trophy): boolean {
  const { count_of_maneuvers_got: got, count_of_maneuvers_faced: faced } = trophy;
  if (got === null || faced === null) return trophy.outcome === "right";
  return faced > 0 && got >= faced;
}

function standingOf(trophies: Trophy[] | undefined): {
  lastWorkedAt: string | null;
  latest: Trophy | null;
  streak: number;
} {
  const list = trophies ?? [];
  // The worker sends them oldest first, so the last one is the most recent.
  const latest = list.length ? list[list.length - 1] : null;

  // A run either way, counted the same and signed. The latest attempt sets
  // which run it is -- full marks or short of them -- and the count is how far
  // back that verdict holds unbroken. Signed rather than split in two, because
  // +3 and -3 are the same measurement of the same thing and a row can only be
  // in one of them.
  //
  // Skips never reach here -- the payload carries answered attempts only -- so
  // passing a problem over neither builds a run nor breaks one.
  const latestWasFullMarks = latest ? wasFullMarks(latest) : false;
  let streak = 0;
  for (let i = list.length - 1; i >= 0 && wasFullMarks(list[i]) === latestWasFullMarks; i--) {
    streak++;
  }
  if (!latestWasFullMarks) streak = -streak;

  return { lastWorkedAt: latest ? latest.created_at : null, latest, streak };
}

/**
 * Which of the three grounds the run's badge wears.
 *
 * Its own function because the cell that used to decide this inline now has
 * three answers to choose between, and a nested ternary in the middle of a row
 * of table cells is where a fourth would go wrong.
 */
function streakBadgeClassFor(standing: { streak: number; latest: Trophy | null }): string {
  if (standing.streak < 0) return "is-last-attempt-missed";
  return standing.latest?.needed_help_during_attempt === 1
    ? "is-last-attempt-helped"
    : "is-last-attempt-unaided";
}

/** The credit of the most recent graded attempt, unreduced. */
function creditText(latest: Trophy | null): string {
  if (!latest || latest.count_of_maneuvers_faced === null) return "";
  return `${latest.count_of_maneuvers_got}/${latest.count_of_maneuvers_faced}`;
}

/**
 * What was true of the last attempt beyond its credit.
 *
 * Multi-valued on purpose though only one flag exists to raise so far: this is
 * the cell anything else about an attempt will be filed in, and a field that
 * had to be widened from one value to many later would take every row that
 * read it along. Nothing in the database is multi -- the flags are read off
 * columns that each know one thing -- and the cell assembles them.
 */
function flagChipsFor(latest: Trophy | null): HTMLElement[] {
  const raised: string[] = [];
  if (latest?.needed_help_during_attempt === 1) raised.push("help");
  return raised.map((flag) => h("span", { class: "attempt-flag" }, [flag]));
}

/** today / yesterday / Sat / 8 days ago. */
function formatLastWorked(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso);
  const days = daysBetween(then, new Date());
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  // Inside the week the weekday is the thing that places it; past that the
  // weekday has come round again and only a count still means anything.
  if (days < 7) {
    const name = WEEKDAY_NAMES[then.getDay()];
    return name.charAt(0).toUpperCase() + name.slice(1, 3);
  }
  return `${days} days ago`;
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
        ...TABLE_TAG_FIELDS.map((field) => h("th", { class: `col-field-${field}` }, [field])),
        h("th", { class: "col-credit" }, ["credit"]),
        h("th", { class: "col-last" }, ["last"]),
        h("th", { class: "col-streak" }, ["streak"]),
        h("th", { class: "col-speed" }, ["speed"]),
        h("th", { class: "col-flags" }, ["flags"]),
        h("th", { class: "col-why" }, ["why"]),
        h("th", { class: "col-menu" }, []),
      ]),
    ]),
    body,
  ]);
}

/** A class by id, every problem, or the ones free generate made. */
type BankTabKey = number | "generated";

/** One assignment's problems within the open tab, or those filed under none. */
interface AssignmentGroup {
  key: string;
  tag: StudyContextTag | null;
  problems: MathPracticeProblem[];
}

export async function renderBank(
  root: HTMLElement,
  go: (view: View) => void,
  // Set when the bank is rebuilt from inside itself, so a rebuild lands on the
  // tab that was asked for rather than the one remembered from last visit.
  startOn?: BankTabKey,
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

  const classTags = () => tagCatalogue.filter((tag) => tag.field === "class");

  // The open tab is the class filter: every problem 6801 has, or the ones
  // written to a prompt rather than filed off a page. There is no tab for all
  // of them -- a bank of every class at once is a list to scroll, not one to
  // pick from, and picking is what this page is for. A class retired since the
  // last visit falls to the first class still standing.
  const remembered = readStandingStudyContextTagFilter();
  const firstTab = (): BankTabKey => classTags()[0]?.id ?? "generated";
  let openTab: BankTabKey =
    startOn ??
    (remembered === "generated" || classTags().some((tag) => tag.id === remembered)
      ? remembered!
      : firstTab());

  // Problems added from a pane on this page, which the table has not seen.
  // The pane that added them stays put -- its "work it now" is the point of it
  // -- and the next tab pressed rebuilds the bank instead of repainting it.
  let bankIsStale = false;

  const closedGroups = readClosedAssignmentGroups();

  // A list per id, since a problem set under two assignments is a row in each
  // group, and a tick has to show on both.
  const rowsById = new Map<number, { row: HTMLElement; box: HTMLInputElement }[]>();
  // Each group's own tick box, repainted with the rows so it can read full,
  // empty or part-ticked.
  const groupHeaderBoxes: { box: HTMLInputElement; ids: number[] }[] = [];

  const bodyEl = h("tbody");
  const tableEl = buildBankTable(bodyEl);
  const emptyEl = h("div", { class: "bank-note" }, ["nothing filed under that"]);

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
      go({ name: "continuous_scroll_practice_run", runId: run.run_id, problems: run.problems });
    } catch (err) {
      setPracticeStatus(err instanceof Error ? err.message : String(err), true);
      practiceEl.disabled = false;
    }
  });

  function paintTickState(): void {
    for (const [id, entries] of rowsById) {
      const on = ticked.has(id);
      for (const entry of entries) {
        entry.row.classList.toggle("is-ticked", on);
        entry.box.checked = on;
      }
    }
    for (const { box, ids } of groupHeaderBoxes) {
      const count = ids.filter((id) => ticked.has(id)).length;
      box.checked = count > 0 && count === ids.length;
      box.indeterminate = count > 0 && count < ids.length;
    }
    practiceEl.disabled = ticked.size === 0;
    // The count rides on the button rather than a line beneath it: it is what
    // the press is about to do, and the line below is left for what the press
    // then says.
    practiceEl.textContent = ticked.size ? `practice ${ticked.size}` : "practice";
    setPracticeStatus("");
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

  // Colour tells one class from another at a glance, and there are three of
  // them. Assignments run to a term's worth, so the palette wraps round twice
  // and the colour stops meaning anything -- worse, it reads as a grouping that
  // is not there. The numbers already sort themselves, so the chips go plain
  // and the colour stays a fact about the class column.
  const chipOf = (tag: StudyContextTag, extra = "") =>
    h(
      "span",
      {
        class:
          `study-context-tag-chip${
            tag.field === "assignment" ? "" : ` chip-color-${tag.chip_color_ordinal}`
          }${extra}`,
      },
      [tag.name],
    );

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
  }

  /** The open tab's problems, open groups and shut alike. */
  function inOpenTab(list: MathPracticeProblem[]): MathPracticeProblem[] {
    // Free generate mints from a prompt, so its problems are already marked as
    // such on the way in -- the tab needs no flag of its own.
    if (openTab === "generated") {
      return list.filter((p) => p.how_this_problem_came_to_be === "built_to_order_from_a_prompt");
    }
    return list.filter((p) => p.study_context_tag_ids.includes(openTab as number));
  }

  const groupKeyOf = (tag: StudyContextTag | null) => `${openTab}:${tag?.id ?? "none"}`;
  const isGroupOpen = (group: AssignmentGroup) => !closedGroups.has(group.key);

  /**
   * The open tab cut up by assignment: unvaried originals only, in the order
   * they came in within each group. Variants of a problem are reached by expanding it
   * rather than listed beside it, so the bank stays as long as what was put in.
   *
   * Groups run most recently practised first, so the assignment being worked
   * this week sits at the top. Practice on a variant counts for its original's
   * assignments, since a variant wears what it was varied from. Groups never
   * practised follow in name order, numbers counted as numbers so Homework 10
   * comes after Homework 9, and the problems filed under no assignment come
   * last. The run is served in this order, so a set started from here goes one
   * assignment at a time.
   */
  function assignmentGroups(): AssignmentGroup[] {
    const inTab = inOrderTheyCameIn(
      inOpenTab(problems.filter((p) => !p.archived_at && p.parent_problem_varied_from === null)),
    );
    const byTag = new Map<number | null, AssignmentGroup>();
    const groupFor = (tag: StudyContextTag | null) => {
      let group = byTag.get(tag?.id ?? null);
      if (!group) {
        group = { key: groupKeyOf(tag), tag, problems: [] };
        byTag.set(tag?.id ?? null, group);
      }
      return group;
    };
    for (const problem of inTab) {
      const assignments = tagsOf(problem, "assignment");
      if (!assignments.length) groupFor(null).problems.push(problem);
      for (const tag of assignments) groupFor(tag).problems.push(problem);
    }
    // Latest graded attempt per assignment, across every problem wearing it.
    // ISO stamps, so the strings compare as the times do.
    const lastPractisedAt = new Map<number, string>();
    for (const problem of problems) {
      const latest = byProblem.get(problem.id)?.at(-1)?.created_at;
      if (!latest) continue;
      for (const tag of tagsOf(problem, "assignment")) {
        if (latest > (lastPractisedAt.get(tag.id) ?? "")) lastPractisedAt.set(tag.id, latest);
      }
    }
    return [...byTag.values()].sort((a, b) => {
      if (!a.tag) return 1;
      if (!b.tag) return -1;
      const aAt = lastPractisedAt.get(a.tag.id) ?? "";
      const bAt = lastPractisedAt.get(b.tag.id) ?? "";
      if (aAt !== bAt) return aAt < bAt ? 1 : -1;
      return a.tag.name.localeCompare(b.tag.name, undefined, { numeric: true });
    });
  }

  /**
   * What the table is currently showing, in the order it is painted: every
   * problem in an open group, once each even where it sits in two.
   */
  function shownProblems(): MathPracticeProblem[] {
    const seen = new Set<number>();
    const shown: MathPracticeProblem[] = [];
    for (const group of assignmentGroups()) {
      if (!isGroupOpen(group)) continue;
      for (const problem of group.problems) {
        if (seen.has(problem.id)) continue;
        seen.add(problem.id);
        shown.push(problem);
      }
    }
    return shown;
  }

  // The order they came in, always: read off the page, or handed back by the
  // model. A homework then reads down the way it is printed, 2.1(a) before
  // 2.11(b), and working through a group is going down a list -- nothing
  // jumps to the top because it was just worked or never was. The run is
  // served in this order too, so a set opens where the homework opens.
  function inOrderTheyCameIn(list: MathPracticeProblem[]): MathPracticeProblem[] {
    return [...list].sort((a, b) => a.id - b.id);
  }

  /** Repaint the table from the local list. */
  function paintAll(): void {
    const groups = assignmentGroups();

    rowsById.clear();
    groupHeaderBoxes.length = 0;
    bodyEl.replaceChildren(
      ...groups.flatMap((group) => [
        groupHeaderRow(group),
        ...(isGroupOpen(group) ? group.problems.map(bankRow) : []),
      ]),
    );

    tableEl.hidden = !groups.length;
    emptyEl.hidden = Boolean(groups.length);

    // Recoloured with the table, since a retag can move a problem between classes.
    const nextLedgerEl = renderRollingWeekPracticeLedger(trophies, problems, tagCatalogue);
    ledgerEl.replaceWith(nextLedgerEl);
    ledgerEl = nextLedgerEl;

    // A tick the tab or a shut group has just hidden is not a tick any more.
    for (const id of [...ticked]) if (!rowsById.has(id)) ticked.delete(id);
    paintTickState();
  }

  /**
   * The heading an assignment's rows sit under, and the switch that shuts them.
   *
   * A shut group stays on the page as this one line, with how much of it is
   * green on the streak, so what was set aside is still in view -- which
   * a filter that simply hid it would not allow. The box ticks the lot.
   */
  function groupHeaderRow(group: AssignmentGroup): HTMLElement {
    const open = isGroupOpen(group);
    const ids = group.problems.map((p) => p.id);

    // Attempted is answered at least once; skips never reach the trophies, so
    // passing one over doesn't count. Correct is green on the streak -- a run
    // of full marks got alone, the same test the row's badge colours by. Help
    // or a miss is not green.
    const standings = group.problems.map((p) => standingOf(byProblem.get(p.id)));
    const attemptedCount = standings.filter((standing) => standing.latest).length;
    const greenCount = standings.filter(
      (standing) =>
        standing.streak > 0 && streakBadgeClassFor(standing) === "is-last-attempt-unaided",
    ).length;

    const setOpen = (on: boolean) => {
      if (on) closedGroups.delete(group.key);
      else closedGroups.add(group.key);
      writeClosedAssignmentGroups(closedGroups);
    };

    const boxEl = h("input", {
      type: "checkbox",
      "aria-label": `tick all of ${group.tag?.name ?? "no assignment"}`,
    });
    groupHeaderBoxes.push({ box: boxEl, ids });
    boxEl.addEventListener("click", (event) => {
      event.stopPropagation();
      const on = boxEl.checked;
      for (const id of ids) {
        if (on) ticked.add(id);
        else ticked.delete(id);
      }
      // Ticking a shut group opens it: a tick on a row nobody can see is one
      // the practice count would have to own up to without showing.
      if (on && !open) {
        setOpen(true);
        paintAll();
      } else {
        paintTickState();
      }
    });

    const nameEl = h("span", { class: "assignment-group-name" }, [
      group.tag?.name ?? "no assignment",
    ]);
    const menuCell = h("td", { class: "col-menu" });

    const row = h("tr", { class: `assignment-group-row${open ? " is-open" : ""}` }, [
      h("td", { class: "col-select" }, [boxEl]),
      h("td", { colspan: TABLE_COLUMN_COUNT - 2 }, [
        h("span", { class: "assignment-group-caret" }, [open ? "▾" : "▸"]),
        nameEl,
        h("span", { class: "assignment-group-rollup" }, [
          h("span", {}, [`${attemptedCount}/${ids.length} attempted`]),
          " ",
          h("span", {}, [`${greenCount}/${ids.length} correct`]),
        ]),
      ]),
      menuCell,
    ]);
    row.addEventListener("click", () => {
      setOpen(!open);
      paintAll();
    });

    // "no assignment" is the absence of a tag, so there is nothing to rename --
    // but its problems can still be moved.
    const tag = group.tag;

    // ---- move to class -------------------------------------------------------
    // Every problem in the group at once, typed where the group's name sits.
    // Starts on the class they share, if they share one, so a slip is easy to
    // see; a group across classes starts blank.
    function beginMoveToClass(): void {
      closeOpenMenu?.();
      const classSets = group.problems.map((p) =>
        tagsOf(p, "class").map((t) => t.name).join(", "),
      );
      const shared = classSets.every((s) => s === classSets[0]) ? classSets[0] ?? "" : "";
      const input = h("input", {
        class: "study-context-tag-input",
        list: catalogueListId("class"),
        placeholder: "class",
        value: shared,
      });
      nameEl.replaceChildren(input);
      input.focus();
      input.select();

      let settled = false;
      const finish = async (save: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        const next = parseTagNames(input.value);
        nameEl.replaceChildren(group.tag?.name ?? "no assignment");
        if (!save || next.join(", ") === shared) return;
        try {
          const result = await retagProblems(ids, "class", next);
          tagCatalogue = result.study_context_tags;
          for (const problem of problems) {
            const moved = result.study_context_tag_ids_by_problem[problem.id];
            if (moved) problem.study_context_tag_ids = moved;
          }
          paintTagCatalogue();
          paintAll();
          setPracticeStatus(
            `moved ${ids.length} to ${next.length ? next.join(", ") : "no class"}`,
          );
        } catch (err) {
          setPracticeStatus(err instanceof Error ? err.message : String(err), true);
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

    // ---- rename ------------------------------------------------------------
    // The tag itself, so every problem wearing it follows -- in every class
    // that shares it, since a tag is one row per (field, name).
    function beginRename(tag: StudyContextTag): void {
      closeOpenMenu?.();
      const input = h("input", { class: "problem-name-input", value: tag.name });
      nameEl.replaceChildren(input);
      input.focus();
      input.select();

      let settled = false;
      const finish = async (save: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        const next = parseTagNames(input.value)[0];
        nameEl.replaceChildren(tag.name);
        if (!save || !next || next === tag.name) return;
        try {
          const result = await renameStudyContextTag(tag.id, next);
          tagCatalogue = result.study_context_tags;
          paintTagCatalogue();
          paintAll();
        } catch (err) {
          setPracticeStatus(err instanceof Error ? err.message : String(err), true);
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

    function openMenu(): void {
      closeOpenMenu?.();
      const menu = h("div", { class: "row-menu" }, [
        ...(tag
          ? [h("button", { type: "button", onclick: () => beginRename(tag) }, ["rename"])]
          : []),
        h("button", { type: "button", onclick: beginMoveToClass }, ["move to class…"]),
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
            // Not a toggle of the group, and not the document listener that
            // would shut the menu the instant it opens.
            event.stopPropagation();
            openMenu();
          },
        },
        ["⋯"],
      ),
    );
    // Clicks inside the menu are its own, not a toggle of the group.
    menuCell.addEventListener("click", (event) => event.stopPropagation());
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu();
    });
    return row;
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

    const nameCellContents = () => [
      problem.name,
      // A problem with no table has nothing to reveal at the end of a run, so
      // the bank says so rather than letting it surprise you there.
      ...(problem.last_solved_by_llm_at
        ? []
        : [h("span", { class: "awaiting-solve" }, ["  · no table yet"])]),
    ];
    const nameCell = h("td", { class: "problem-name" }, nameCellContents());
    // Mouse only: on the phone a tap is a tick, and it would fire this too.
    nameCell.addEventListener("pointerenter", (event) => {
      if ((event as PointerEvent).pointerType === "mouse") {
        showBankRowStatementPeekCard(nameCell, problem.statement_html);
      }
    });
    nameCell.addEventListener("pointerleave", hideBankRowStatementPeekCard);
    nameCell.addEventListener("pointerdown", hideBankRowStatementPeekCard);
    const menuCell = h("td", { class: "col-menu" });

    const entries = rowsById.get(problem.id);
    if (entries) entries.push({ row, box: boxEl });
    else rowsById.set(problem.id, [{ row, box: boxEl }]);

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

    // ---- tags, edited where they sit ---------------------------------------
    //
    // The field's names as a comma list in whatever cell asked, completed from
    // the catalogue. The class edits in its own cell; the assignment has no
    // cell now that it heads the group, so it borrows the name's.
    function editTagsInPlace(
      host: HTMLElement,
      field: StudyContextTagField,
      restore: () => void,
    ): void {
      const before = tagsOf(problem, field).map((tag) => tag.name);
      const input = h("input", {
        class: "study-context-tag-input",
        list: catalogueListId(field),
        placeholder: field,
        value: before.join(", "),
      });
      host.replaceChildren(input);
      input.focus();
      input.select();

      let settled = false;
      const finish = async (save: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        const next = parseTagNames(input.value);
        restore();
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
          restore();
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

      paint();
      cell.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!cell.querySelector("input")) editTagsInPlace(cell, field, paint);
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
    function openDetail(showing: "text" | "screenshot" | "solution"): void {
      const open = row.nextElementSibling as HTMLElement | null;
      if (open?.classList.contains("detail-row")) open.remove();

      const shown: (Node | string)[] = [];
      const acts: HTMLElement[] = [];
      if (showing === "solution") {
        // The table as it stands, with the means to redo it right under it:
        // this is where a solution gone the long way round gets noticed
        // without having to be worked first.
        const statementEl = h("div", { class: "problem-body" });
        renderMathHtml(statementEl, problem.statement_html);
        const tableEl = h("div", { class: "bank-note" }, ["loading solution..."]);
        void peekAtManeuvers(problem.id).then(
          ({ maneuvers }) =>
            tableEl.replaceWith(
              maneuvers.length
                ? renderManeuverTable(maneuvers, { mode: "grade" })
                : h("div", { class: "bank-note" }, ["not solved yet"]),
            ),
          (err) => {
            tableEl.textContent = err instanceof Error ? err.message : String(err);
            tableEl.classList.add("err");
          },
        );
        const { howEl, solveEl } = renderReSolveControls({
          problemId: problem.id,
          editablePerProblemInstructionsToLlm: problem.editable_per_problem_instructions_to_llm,
          alreadySolved: problem.last_solved_by_llm_at !== null,
          onHowSaved: (text) => {
            problem.editable_per_problem_instructions_to_llm = text;
          },
          onReSolved: () => {
            problem.last_solved_by_llm_at ??= new Date().toISOString();
            bankIsStale = true;
            openDetail("solution");
          },
        });
        shown.push(statementEl, tableEl, howEl);
        acts.push(solveEl);
      } else if (showing === "text") {
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
            ...acts,
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

    // ---- re-solve ----------------------------------------------------------
    //
    // The whole row reports, since a solve is a model call and runs long enough
    // that a silent menu item would read as a dead one.
    async function beginReSolve(): Promise<void> {
      closeOpenMenu?.();
      setPracticeStatus(`solving ${problem.name}...`);
      try {
        const { maneuver_count } = await solveStepByStep(problem.id);
        bankIsStale = true;
        setPracticeStatus(`${problem.name}: ${maneuver_count} maneuvers`);
      } catch (err) {
        setPracticeStatus(err instanceof Error ? err.message : String(err), true);
      }
    }

    // ---- delete ------------------------------------------------------------
    //
    // For good: its attempts go with it, so the ledger and the wall lose them
    // too. Asked once, since nothing brings it back.
    async function beginDelete(): Promise<void> {
      closeOpenMenu?.();
      if (!confirm(`delete "${problem.name}" and every attempt at it? this cannot be undone.`)) {
        return;
      }
      try {
        await deleteProblem(problem.id);
        problems = problems.filter((p) => p.id !== problem.id);
        trophies = trophies.filter((t) => t.math_practice_problem_id !== problem.id);
        byProblem.delete(problem.id);
        ticked.delete(problem.id);
        paintAll();
        setPracticeStatus(`deleted ${problem.name}`);
      } catch (err) {
        setPracticeStatus(err instanceof Error ? err.message : String(err), true);
      }
    }

    // ---- menu --------------------------------------------------------------
    function openMenu(): void {
      closeOpenMenu?.();
      const item = (label: string, act: () => void, enabled = true) =>
        h("button", { type: "button", disabled: !enabled, onclick: act }, [label]);

      const menu = h("div", { class: "row-menu" }, [
        item("view problem text", () => openDetail("text")),
        item("view solution", () => openDetail("solution")),
        // A problem written to order was never read off anything, so there is
        // nothing to show it against.
        item("view screenshot", () => openDetail("screenshot"), hasScreenshot()),
        item("rename", beginRename),
        item("move to assignment…", () =>
          editTagsInPlace(nameCell, "assignment", () =>
            nameCell.replaceChildren(...nameCellContents()),
          ),
        ),
        // Straight through, with no table shown and nothing asked. "view
        // solution" is for a table that is wrong; this is for the maintenance
        // pass -- the instructions have changed and the tables written before
        // them need bringing up to them, a job done down a list.
        item("re-solve", beginReSolve),
        item("delete", () => void beginDelete()),
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
      ...TABLE_TAG_FIELDS.map(fieldCell),
      h("td", { class: "col-credit" }, [creditText(standing.latest)]),
      h("td", { class: "col-last" }, [formatLastWorked(standing.lastWorkedAt)]),
      // Nothing rather than "+0": a row never worked should read as quiet, not
      // as a score of zero. Everything else is signed, and the sign is the
      // whole reading -- +3 is three clean in a row, -3 is three short of full
      // credit in a row, and the eye wants to find those two apart without
      // reading either.
      //
      // Three grounds, not two. Green for a run got alone, amber for one that
      // wanted help, red for a run that is not getting there at all -- so help
      // stays a different claim from full marks, while falling short stays a
      // different thing from both. Short of full credit is red whether or not
      // help was taken: help did not rescue it, which is the point.
      //
      // The colour rides a span rather than the cell, so the ground it sits on
      // is a badge round the figure instead of a stripe the height of the row.
      h(
        "td",
        { class: "col-streak" },
        standing.streak
          ? [
              h(
                "span",
                { class: streakBadgeClassFor(standing) },
                [standing.streak > 0 ? `+${standing.streak}` : String(standing.streak)],
              ),
            ]
          : [],
      ),
      // Mid is the default and says nothing, so only slow and fast are shown.
      h("td", { class: "col-speed" }, [
        standing.latest?.self_reported_working_speed === "mid"
          ? ""
          : (standing.latest?.self_reported_working_speed ?? ""),
      ]),
      h("td", { class: "col-flags" }, flagChipsFor(standing.latest)),
      h("td", { class: "col-why" }, [standing.latest?.why_this_one_went_wrong ?? ""]),
      menuCell,
    );
    return row;
  }

  // ---- tabs ----------------------------------------------------------------
  const addAssignment = renderAddAssignment(
    () => {
      bankIsStale = true;
    },
    () => tagCatalogue,
    go,
  );
  const addAssignmentPane = h("div", {}, [addAssignment.el]);
  const practiceLaunchEl = h("div", { class: "row practice-launch-control" }, [
    practiceEl,
    tickAllEl,
    untickAllEl,
  ]);
  const bankPane = h("div", {}, [tableEl, emptyEl, practiceLaunchEl, practiceStatusEl]);

  const freeGenerate = renderFreeGenerate(
    () => {
      bankIsStale = true;
    },
    () => tagCatalogue,
    go,
  );
  const freeGeneratePane = h("div", {}, [freeGenerate.el]);

  const instructions = renderEditablePerJobInstructionsToLlm();
  const instructionsPane = h("div", {}, [instructions.el]);

  // ---- panes ---------------------------------------------------------------
  // The tab strip stays up on every pane, so a tab is always the way back to
  // the bank and the menu is never the only door.
  const panes = [bankPane, addAssignmentPane, freeGeneratePane, instructionsPane];
  function showPane(which: HTMLElement): void {
    for (const pane of panes) pane.hidden = pane !== which;
    // The ledger and the lit tab both describe the bank. Over any other pane
    // the one covers the editing and the other claims a tab is open that is
    // not; a tab pressed to come back lights itself again.
    const onBank = which === bankPane;
    ledgerEl.hidden = !onBank;
    if (!onBank) for (const el of tabEls) el.classList.remove("is-on");
  }

  // ---- tabs: one per class, then generated ----------------------------------
  const tabKeys: BankTabKey[] = [...classTags().map((tag) => tag.id), "generated"];
  const labelOf = (key: BankTabKey): string =>
    typeof key === "number" ? (classTags().find((tag) => tag.id === key)?.name ?? "?") : key;
  const tabEls = tabKeys.map((key) => h("button", { type: "button", class: "tab" }, [labelOf(key)]));
  const tabStripEl = h("div", { class: "tab-strip" }, tabEls);

  function openTabAt(key: BankTabKey): void {
    if (bankIsStale) {
      void renderBank(root, go, key);
      return;
    }
    openTab = key;
    writeStandingStudyContextTagFilter(key);
    tabEls.forEach((el, i) => el.classList.toggle("is-on", tabKeys[i] === key));
    // The ticks are dropped on the way in, or practice would act on a selection
    // made against a table that is no longer the one on screen.
    ticked.clear();
    paintTagCatalogue();
    paintAll();
    showPane(bankPane);
  }
  tabEls.forEach((el, i) => el.addEventListener("click", () => openTabAt(tabKeys[i])));

  // ---- the corner menu ------------------------------------------------------
  // Authoring, both of them: done rarely, never mid-practice. Out of the way of
  // the tabs, which are for picking something to work.
  const menuEl = h("div", { class: "corner-menu-items" }, [
    h(
      "button",
      {
        type: "button",
        // Classes created in the bank while this form sat hidden.
        onclick: () => {
          addAssignment.refreshTagChips();
          showPane(addAssignmentPane);
        },
      },
      ["add assignment"],
    ),
    h(
      "button",
      {
        type: "button",
        onclick: () => {
          freeGenerate.refreshTagChips();
          showPane(freeGeneratePane);
        },
      },
      ["free generate"],
    ),
    h(
      "button",
      {
        type: "button",
        onclick: () => {
          void instructions.load();
          showPane(instructionsPane);
        },
      },
      ["edit job-level instructions"],
    ),
  ]);
  menuEl.hidden = true;

  const menuButtonEl = h(
    "button",
    { type: "button", class: "corner-menu-button", title: "menu" },
    ["\u2630"],
  );
  menuButtonEl.addEventListener("click", (event) => {
    // The document listener closes whatever is open; without this the menu
    // would close itself on the very click that opened it.
    event.stopPropagation();
    const wasOpen = !menuEl.hidden;
    closeOpenMenu?.();
    if (wasOpen) return;
    menuEl.hidden = false;
    closeOpenMenu = () => {
      menuEl.hidden = true;
      closeOpenMenu = null;
    };
  });

  // The bank opens on the class last worked: most visits are to pick something
  // to practise, not to put something new in.
  openTabAt(openTab);

  root.replaceChildren(
    h("div", { class: "corner-menu" }, [menuButtonEl, menuEl]),
    ledgerEl,
    tabStripEl,
    bankPane,
    addAssignmentPane,
    freeGeneratePane,
    instructionsPane,
    ...catalogueEls.values(),
    h("div", { class: "lightspeed-motto-line" }, ["limitations are in the mind"]),
  );
}
