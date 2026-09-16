import {
  archiveNamedProblemGenerator,
  listNamedProblemGenerators,
  practiceNamedProblemGenerator,
  renameNamedProblemGenerator,
  retagNamedProblemGenerator,
  reviseNamedProblemGeneratorPrompt,
  trophyWall,
} from "../api";
import { h } from "../lib/dom";
import { parseTagNames, renderNewGeneratorForm } from "./compose";
import { square } from "./trophy-wall";
import { STUDY_CONTEXT_TAG_FIELDS } from "../types";
import type {
  NamedProblemGenerator,
  StudyContextTag,
  StudyContextTagField,
  Trophy,
  View,
} from "../types";

// Enough squares to read a streak off, few enough to sit in one cell beside the
// four field columns.
const STRIP_LENGTH = 12;

// Prompts are not edited on the phone. A prompt is tuned against the
// screenshots it was written for, and there is no way to hold both on a 390px
// screen and still read the maths -- so the door is shut rather than left open
// onto something unusable. Matches the stacking breakpoint in the stylesheet.
const WIDE_ENOUGH_TO_EDIT = "(min-width: 46rem)";

const ROLLING_WEEK_DAYS = 7;

// Both counted in whole days, not elapsed time: something worked on Monday
// evening and something worked on Monday morning are the same number of days
// ago on Thursday, and neither should tip a row over on the hour.
const GONE_COLD_AFTER_DAYS = 7;
const GOING_COLD_AFTER_DAYS = 2;

// Select, name, four fields, strip, menu.
const TABLE_COLUMN_COUNT = 8;

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

// One menu open at a time, closed by the next click anywhere. Bound once at
// module scope -- the table repaints on every archive, and a listener attached
// per render would stack a copy each time.
let closeOpenMenu: (() => void) | null = null;
document.addEventListener("click", () => closeOpenMenu?.());

/** The most recent graded attempt against a type, and the squares to show for it. */
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
 * measures problems *answered*: back out of a set before the answer page and
 * nothing here moves, which is the same bargain the wall makes.
 */
function renderRollingWeekPracticeLedger(trophies: Trophy[]): HTMLElement {
  const perDay = new Map<string, number>();
  for (const trophy of trophies) {
    const when = new Date(trophy.created_at);
    if (isNaN(when.getTime())) continue;
    const key = localDayKey(when);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  // Bucketed in local time rather than UTC: a set worked at 9pm belongs to that
  // evening, not to the next morning in Greenwich.
  const today = new Date();
  const days = Array.from({ length: ROLLING_WEEK_DAYS }, (_, back) => {
    const day = new Date(today);
    day.setDate(today.getDate() - back);
    return {
      isToday: back === 0,
      label: back === 0 ? "today" : WEEKDAY_NAMES[day.getDay()],
      count: perDay.get(localDayKey(day)) ?? 0,
    };
  });

  const busiest = Math.max(1, ...days.map((day) => day.count));

  return h("aside", { class: "rolling-week-practice-ledger" }, [
    h("div", { class: "ledger-title" }, ["last 7 days"]),
    ...days.map((day) =>
      h("div", { class: day.isToday ? "ledger-day is-today" : "ledger-day" }, [
        h("span", { class: "day-name" }, [day.label]),
        h("span", { class: "day-track" }, [
          h("span", {
            class: "day-bar",
            style: `width:${Math.round((day.count / busiest) * 100)}%`,
          }),
        ]),
        h("span", { class: "day-count" }, [String(day.count)]),
      ]),
    ),
  ]);
}

function buildGeneratorTable(body: HTMLElement): HTMLElement {
  return h("table", { class: "generator-table" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", { class: "col-select" }, []),
        h("th", {}, ["practice type"]),
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

export async function renderGenerators(
  root: HTMLElement,
  go: (view: View) => void,
): Promise<void> {
  root.replaceChildren(h("div", { id: "out" }, ["loading..."]));

  let generators: NamedProblemGenerator[];
  let tagCatalogue: StudyContextTag[];
  let trophies: Trophy[];
  try {
    // Both in flight together: neither depends on the other, and the trophy
    // payload is what the strips and the ledger are built from.
    const [listed, walled] = await Promise.all([
      listNamedProblemGenerators(),
      trophyWall(),
    ]);
    generators = listed.generators;
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

  const byGenerator = new Map<number, Trophy[]>();
  for (const trophy of trophies) {
    const list = byGenerator.get(trophy.named_problem_generator_id);
    if (list) list.push(trophy);
    else byGenerator.set(trophy.named_problem_generator_id, [trophy]);
  }

  // One type is practised at a time, so the table is a list of radio buttons in
  // all but appearance and the button beneath it acts on whichever is lit.
  let selectedId: number | null = null;
  let filterTagId: number | null = null;
  const rowsById = new Map<number, { row: HTMLElement; radio: HTMLInputElement }>();

  const bodyEl = h("tbody");
  const drawerBodyEl = h("tbody");
  const tableEl = buildGeneratorTable(bodyEl);
  const emptyEl = h("div", { class: "generator-stats" }, ["nothing filed under that"]);
  const filterEl = h("div", { class: "study-context-tag-filter" });

  // One list per field: completing a source against the catalogue of classes
  // would offer names that cannot belong there.
  const catalogueEls = new Map<StudyContextTagField, HTMLElement>(
    STUDY_CONTEXT_TAG_FIELDS.map((field) => [
      field,
      h("datalist", { id: catalogueListId(field) }),
    ]),
  );

  const drawerSummaryEl = h("summary", {}, ["unsorted"]);
  const drawerEl = h("details", { class: "archived-drawer" }, [
    drawerSummaryEl,
    buildGeneratorTable(drawerBodyEl),
  ]);

  // ---- the practice control, one for the whole table -----------------------
  const practiceCountEl = h("input", { type: "number", min: 1, max: 40, value: 2 });
  const practiceEl = h("button", { type: "button", class: "practice", disabled: true }, [
    "practice",
  ]);
  const practiceStatusEl = h("div", { class: "generator-stats" });

  const setPracticeStatus = (text: string, isError = false) => {
    practiceStatusEl.textContent = text;
    practiceStatusEl.className = isError ? "generator-stats err" : "generator-stats";
  };

  practiceEl.addEventListener("click", async () => {
    const selected = generators.find((g) => g.id === selectedId);
    if (!selected) return;
    practiceEl.disabled = true;
    // Opus at high effort with a 16k budget is slow enough that a silent button
    // reads as a dead one.
    setPracticeStatus("generating...");
    try {
      const count = Math.max(1, Math.min(40, Number(practiceCountEl.value) || 2));
      const set = await practiceNamedProblemGenerator(selected.id, count);
      if (!set.problems.length) throw new Error("model returned no problems");
      go({
        name: "problem",
        runId: set.run_id,
        requestedCount: set.requested_count,
        problems: set.problems,
        index: 0,
      });
    } catch (err) {
      setPracticeStatus(err instanceof Error ? err.message : String(err), true);
      practiceEl.disabled = false;
    }
  });

  function select(id: number | null): void {
    selectedId = id;
    const selected = id === null ? undefined : generators.find((g) => g.id === id);

    for (const [rowId, entry] of rowsById) {
      const on = rowId === id;
      entry.row.classList.toggle("is-selected", on);
      entry.radio.checked = on;
    }

    practiceEl.disabled = !selected;
    if (selected) {
      // Each type remembers what it was last asked for, so the count follows
      // the selection rather than making Mike retype it.
      practiceCountEl.value = String(selected.requested_count);
      setPracticeStatus(selected.name);
    } else {
      setPracticeStatus("");
    }
  }

  // ---- tags ----------------------------------------------------------------
  const tagById = () => new Map(tagCatalogue.map((tag) => [tag.id, tag]));

  function tagsOf(
    generator: NamedProblemGenerator,
    field: StudyContextTagField,
  ): StudyContextTag[] {
    const byId = tagById();
    return generator.study_context_tag_ids
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
                filterTagId = filterTagId === tag.id ? null : tag.id;
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

  function shownIn(list: NamedProblemGenerator[]): NamedProblemGenerator[] {
    return filterTagId === null
      ? list
      : list.filter((g) => g.study_context_tag_ids.includes(filterTagId!));
  }

  /** Repaint both tables from the local list. Archiving moves a row between them. */
  function paintAll(): void {
    const active = shownIn(generators.filter((g) => !g.archived_at));
    const archived = shownIn(generators.filter((g) => g.archived_at));

    // Never-worked first -- those are the types with coverage but no practice,
    // which is exactly what the dashboard is for noticing. Everything else by
    // how recently it was touched.
    active.sort((a, b) => {
      const aAt = standingOf(byGenerator.get(a.id)).lastWorkedAt;
      const bAt = standingOf(byGenerator.get(b.id)).lastWorkedAt;
      if (!aAt && !bAt) return b.id - a.id;
      if (!aAt) return -1;
      if (!bAt) return 1;
      return bAt < aAt ? -1 : bAt > aAt ? 1 : 0;
    });

    rowsById.clear();
    bodyEl.replaceChildren(...active.map(generatorRow));
    drawerBodyEl.replaceChildren(...archived.map(generatorRow));

    tableEl.hidden = !active.length;
    emptyEl.hidden = Boolean(active.length) || filterTagId === null;
    drawerEl.hidden = !archived.length;
    drawerSummaryEl.textContent = `unsorted (${archived.length})`;

    // A selection the filter has just hidden is not a selection any more.
    select(selectedId !== null && rowsById.has(selectedId) ? selectedId : null);
  }

  function generatorRow(generator: NamedProblemGenerator): HTMLElement {
    const row = h("tr", { class: "generator-row" });
    const standing = standingOf(byGenerator.get(generator.id));

    // Never practised counts as gone cold: it is at least as far from being
    // worked as something last touched a fortnight ago.
    const daysSinceWorked = standing.lastWorkedAt
      ? daysBetween(new Date(standing.lastWorkedAt), new Date())
      : null;
    if (daysSinceWorked === null || daysSinceWorked >= GONE_COLD_AFTER_DAYS) {
      row.classList.add("is-gone-cold");
    } else if (daysSinceWorked > GOING_COLD_AFTER_DAYS) {
      row.classList.add("is-going-cold");
    }

    const radioEl = h("input", {
      type: "radio",
      name: "selected-practice-type",
      "aria-label": generator.name,
    });

    const nameCell = h("td", { class: "generator-name", title: generator.prompt_text }, [
      generator.name,
    ]);
    const menuCell = h("td", { class: "col-menu" });

    rowsById.set(generator.id, { row, radio: radioEl });

    // The row is the selection target. Anything inside it that does something
    // else stops the click before it gets here.
    row.addEventListener("click", () => select(generator.id));

    // ---- rename ------------------------------------------------------------
    function beginRename(): void {
      const input = h("input", { class: "generator-name-input", value: generator.name });
      nameCell.replaceChildren(input);
      input.focus();
      input.select();

      let settled = false;
      const finish = async (save: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        const next = input.value.replace(/\s+/g, " ").trim().slice(0, 64);
        const keep = save && Boolean(next) && next !== generator.name;
        nameCell.replaceChildren(keep ? next : generator.name);
        if (!keep) return;

        const previous = generator.name;
        generator.name = next;
        try {
          await renameNamedProblemGenerator(generator.id, next);
        } catch {
          generator.name = previous;
          nameCell.replaceChildren(previous);
        }
      };

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
        const tags = tagsOf(generator, field);
        cell.replaceChildren(
          ...(tags.length
            ? tags.map((tag) => chipOf(tag))
            : [h("span", { class: "study-context-tag-empty" }, ["+"])]),
        );
      }

      function beginEdit(): void {
        const before = tagsOf(generator, field).map((tag) => tag.name);
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
            const result = await retagNamedProblemGenerator(generator.id, field, next);
            tagCatalogue = result.study_context_tags;
            generator.study_context_tag_ids = result.study_context_tag_ids;
            // A tag just retired cannot go on being the filter.
            if (filterTagId !== null && !tagCatalogue.some((t) => t.id === filterTagId)) {
              filterTagId = null;
            }
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

    // ---- edit prompt -------------------------------------------------------
    function beginPromptEdit(): void {
      if ((row.nextElementSibling as HTMLElement | null)?.classList.contains("prompt-editor-row")) {
        return;
      }

      const textarea = h("textarea", { class: "generator-prompt" });
      textarea.value = generator.prompt_text;

      const statusEl = h("div", { class: "generator-stats" });
      const cancelEl = h("button", { type: "button", class: "grade" }, ["cancel"]);
      const saveEl = h("button", { type: "button", class: "grade" }, ["save"]);

      // The screenshots are as much of the prompt as the words are -- several of
      // these prompts say little more than "problems like this" -- so tuning the
      // text without seeing them is guesswork. Each links to itself at full size.
      const shotsEl = h("ul", { class: "shots generator-shots" },
        generator.attachment_ids.map((id) =>
          h("li", {}, [
            h("a", { href: `/?shot=${id}`, target: "_blank", rel: "noreferrer" }, [
              h("img", { src: `/?shot=${id}`, alt: "" }),
            ]),
          ]),
        ),
      );

      const count = generator.attachment_ids.length;
      // Side by side, so the words being tuned and the pictures they refer to
      // are both on screen at once. Stacked, one of them is always scrolled off.
      const panel = h("div", { class: count ? "prompt-editor has-shots" : "prompt-editor" }, [
        textarea,
        ...(count
          ? [
              h("div", { class: "shots-panel" }, [
                h("div", { class: "generator-stats" }, [
                  `${count} screenshot${count === 1 ? "" : "s"} the model sees`,
                ]),
                shotsEl,
              ]),
            ]
          : []),
        h("div", { class: "acts" }, [saveEl, cancelEl, statusEl]),
      ]);

      const editorRow = h("tr", { class: "prompt-editor-row" }, [
        h("td", { colspan: TABLE_COLUMN_COUNT }, [panel]),
      ]);
      editorRow.addEventListener("click", (event) => event.stopPropagation());
      row.after(editorRow);
      textarea.focus();

      cancelEl.addEventListener("click", () => editorRow.remove());
      saveEl.addEventListener("click", async () => {
        const next = textarea.value.trim();
        if (!next) {
          statusEl.textContent = "a generator needs a prompt";
          statusEl.className = "generator-stats err";
          return;
        }
        editorRow.remove();
        if (next === generator.prompt_text) return;

        const previous = generator.prompt_text;
        generator.prompt_text = next;
        nameCell.setAttribute("title", next);
        try {
          await reviseNamedProblemGeneratorPrompt(generator.id, next);
        } catch (err) {
          generator.prompt_text = previous;
          nameCell.setAttribute("title", previous);
          setPracticeStatus(err instanceof Error ? err.message : String(err), true);
        }
      });
    }

    // ---- archive / restore -------------------------------------------------
    async function setArchived(archived: boolean): Promise<void> {
      const previous = generator.archived_at;
      generator.archived_at = archived ? new Date().toISOString() : null;
      paintAll();
      try {
        await archiveNamedProblemGenerator(generator.id, archived);
      } catch {
        generator.archived_at = previous;
        paintAll();
      }
    }

    // ---- menu --------------------------------------------------------------
    function openMenu(): void {
      closeOpenMenu?.();
      const item = (label: string, act: () => void) =>
        h("button", { type: "button", onclick: act }, [label]);

      // Read at open time, not at render time, so a resized window is respected
      // without repainting the table.
      const wideEnough = window.matchMedia(WIDE_ENOUGH_TO_EDIT).matches;
      const editEl = wideEnough
        ? item("edit prompt", beginPromptEdit)
        : h("button", { type: "button", disabled: true }, ["edit prompt (desktop)"]);

      const menu = h("div", { class: "generator-menu" }, [
        item("rename", beginRename),
        editEl,
        generator.archived_at
          ? item("restore", () => void setArchived(false))
          : item("archive", () => void setArchived(true)),
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
          class: "generator-menu-open",
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
      h("td", { class: "col-select" }, [radioEl]),
      nameCell,
      ...STUDY_CONTEXT_TAG_FIELDS.map(fieldCell),
      h("td", { class: "col-strip" }, [
        h("span", { class: "generator-strip" }, standing.strip.map(square)),
      ]),
      menuCell,
    );
    return row;
  }

  // ---- tabs ----------------------------------------------------------------
  const composeForm = renderNewGeneratorForm(go, () => tagCatalogue);
  const generatePane = h("div", {}, [composeForm.el]);
  const tablePane = h("div", {}, [
    filterEl,
    tableEl,
    emptyEl,
    h("div", { class: "row practice-launch-control" }, [practiceCountEl, practiceEl]),
    practiceStatusEl,
    drawerEl,
  ]);

  const tabs: { label: string; pane: HTMLElement; onShow?: () => void }[] = [
    { label: "table", pane: tablePane },
    // Tags created or retired in the table while this form sat hidden.
    { label: "generate", pane: generatePane, onShow: composeForm.refreshTagChips },
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
  // The table opens: most visits are to pick something to practise, not to make
  // a new type.
  showTab(0);

  root.replaceChildren(
    renderRollingWeekPracticeLedger(trophies),
    h("div", { class: "tab-strip" }, tabEls),
    tablePane,
    generatePane,
    ...catalogueEls.values(),
    h("div", { class: "lightspeed-motto-line" }, ["limitations are in the mind"]),
  );
}
