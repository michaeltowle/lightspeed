import {
  archiveNamedProblemGenerator,
  listNamedProblemGenerators,
  practiceNamedProblemGenerator,
  renameNamedProblemGenerator,
  reviseNamedProblemGeneratorPrompt,
  suggestNamedProblemGeneratorName,
  trophyWall,
} from "../api";
import { formatAgo, h } from "../lib/dom";
import { renderNewGeneratorForm } from "./compose";
import { square } from "./trophy-wall";
import type { NamedProblemGenerator, Trophy, View } from "../types";

// Enough squares to read a streak off, few enough to sit on one line of a card
// at phone width.
const STRIP_LENGTH = 24;

// One menu open at a time, closed by the next click anywhere. Bound once at
// module scope -- the grid repaints on every archive, and a listener attached
// per render would stack a copy each time.
let closeOpenMenu: (() => void) | null = null;
document.addEventListener("click", () => closeOpenMenu?.());

interface GeneratorStanding {
  worked: number;
  right: number;
  lastWorkedAt: string | null;
  strip: Trophy[];
}

function standingOf(trophies: Trophy[] | undefined): GeneratorStanding {
  const list = trophies ?? [];
  return {
    worked: list.length,
    right: list.filter((t) => t.self_grade === "right").length,
    // The worker sends them oldest first, so the last one is the most recent.
    lastWorkedAt: list.length ? list[list.length - 1].created_at : null,
    strip: list.slice(-STRIP_LENGTH),
  };
}

function statsText(standing: GeneratorStanding): string {
  if (!standing.worked) return "never worked";
  const pct = Math.round((standing.right / standing.worked) * 100);
  return `${standing.worked} worked  ·  ${pct}%  ·  ${formatAgo(standing.lastWorkedAt!)}`;
}

export async function renderGenerators(
  root: HTMLElement,
  go: (view: View) => void,
): Promise<void> {
  root.replaceChildren(h("div", { id: "out" }, ["loading..."]));

  let generators: NamedProblemGenerator[];
  let trophies: Trophy[];
  try {
    // Both in flight together: neither depends on the other, and the trophy
    // payload is what the cards are built from.
    const [listed, walled] = await Promise.all([
      listNamedProblemGenerators(),
      trophyWall(),
    ]);
    generators = listed.generators;
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

  const gridEl = h("ul", { class: "generator-grid" });
  const drawerListEl = h("ul", { class: "generator-grid" });
  const drawerEl = h("details", { class: "archived-drawer" }, [
    h("summary", {}, ["unsorted"]),
    drawerListEl,
  ]);

  /** Repaint both containers from the local list. Archiving moves a card between them. */
  function paintAll(): void {
    const active = generators.filter((g) => !g.archived_at);
    const archived = generators.filter((g) => g.archived_at);

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

    gridEl.replaceChildren(...active.map(generatorCard));
    drawerListEl.replaceChildren(...archived.map(generatorCard));

    gridEl.hidden = !active.length;
    drawerEl.hidden = !archived.length;
    (drawerEl.firstChild as HTMLElement).textContent = `unsorted (${archived.length})`;
  }

  function generatorCard(generator: NamedProblemGenerator): HTMLElement {
    const card = h("li", { class: "generator-card" });
    const standing = standingOf(byGenerator.get(generator.id));

    const nameEl = h("div", { class: "generator-name", title: generator.prompt_text }, [
      generator.name,
    ]);
    const statsEl = h("div", { class: "generator-stats" }, [statsText(standing)]);

    const setStatus = (text: string, isError = false) => {
      statsEl.textContent = text;
      statsEl.className = isError ? "generator-stats err" : "generator-stats";
    };

    // ---- rename ------------------------------------------------------------
    function beginRename(): void {
      const input = h("input", { class: "generator-name-input", value: generator.name });
      const suggestEl = h(
        "button",
        {
          type: "button",
          class: "grade",
          onclick: async () => {
            suggestEl.disabled = true;
            suggestEl.textContent = "thinking...";
            try {
              const { name } = await suggestNamedProblemGeneratorName(generator.prompt_text);
              input.value = name;
            } catch {
              // Naming is a convenience; typing one is always available.
            }
            suggestEl.disabled = false;
            suggestEl.textContent = "suggest";
            input.focus();
          },
        },
        ["suggest"],
      );

      const panel = h("div", {}, [input, h("div", { class: "acts" }, [suggestEl])]);
      nameEl.replaceWith(panel);
      input.focus();
      input.select();

      let settled = false;
      const finish = async (save: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        const next = input.value.replace(/\s+/g, " ").trim().slice(0, 64);
        panel.replaceWith(nameEl);

        if (!save || !next || next === generator.name) return;
        const previous = generator.name;
        generator.name = next;
        nameEl.textContent = next;
        try {
          await renameNamedProblemGenerator(generator.id, next);
        } catch {
          generator.name = previous;
          nameEl.textContent = previous;
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
      // A click on "suggest" blurs the input; settling on blur would close the
      // box before the suggestion could land in it.
      input.addEventListener("blur", () => {
        setTimeout(() => {
          if (document.activeElement !== suggestEl) void finish(true);
        }, 0);
      });
    }

    nameEl.addEventListener("click", beginRename);

    // ---- edit prompt -------------------------------------------------------
    function beginPromptEdit(): void {
      const textarea = h("textarea", { class: "generator-prompt" });
      textarea.value = generator.prompt_text;

      const cancelEl = h("button", { type: "button", class: "grade" }, ["cancel"]);
      const saveEl = h("button", { type: "button", class: "grade" }, ["save"]);
      const panel = h("div", {}, [textarea, h("div", { class: "acts" }, [saveEl, cancelEl])]);

      const hidden = Array.from(card.children) as HTMLElement[];
      for (const child of hidden) child.hidden = true;
      card.append(panel);
      textarea.focus();

      const close = () => {
        panel.remove();
        for (const child of hidden) child.hidden = false;
      };

      cancelEl.addEventListener("click", close);
      saveEl.addEventListener("click", async () => {
        const next = textarea.value.trim();
        if (!next) {
          setStatus("a generator needs a prompt", true);
          return;
        }
        close();
        if (next === generator.prompt_text) return;

        const previous = generator.prompt_text;
        generator.prompt_text = next;
        nameEl.setAttribute("title", next);
        try {
          await reviseNamedProblemGeneratorPrompt(generator.id, next);
        } catch (err) {
          generator.prompt_text = previous;
          nameEl.setAttribute("title", previous);
          setStatus(err instanceof Error ? err.message : String(err), true);
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

      const menu = h("div", { class: "generator-menu" }, [
        item("rename", beginRename),
        item("edit prompt", beginPromptEdit),
        generator.archived_at
          ? item("restore", () => void setArchived(false))
          : item("archive", () => void setArchived(true)),
      ]);
      card.append(menu);
      closeOpenMenu = () => {
        menu.remove();
        closeOpenMenu = null;
      };
    }

    const menuEl = h(
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
    );

    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu();
    });

    // ---- practice ----------------------------------------------------------
    const countEl = h("input", {
      type: "number",
      min: 1,
      max: 40,
      value: generator.requested_count,
    });

    const practiceEl = h(
      "button",
      {
        type: "button",
        class: "practice",
        onclick: async () => {
          practiceEl.disabled = true;
          // Opus at high effort with a 16k budget is slow enough that a silent
          // button reads as a dead one.
          setStatus("generating...");
          try {
            const count = Math.max(1, Math.min(40, Number(countEl.value) || 2));
            const set = await practiceNamedProblemGenerator(generator.id, count);
            if (!set.problems.length) throw new Error("model returned no problems");
            go({
              name: "problem",
              runId: set.run_id,
              requestedCount: set.requested_count,
              problems: set.problems,
              index: 0,
            });
          } catch (err) {
            setStatus(err instanceof Error ? err.message : String(err), true);
            practiceEl.disabled = false;
          }
        },
      },
      ["practice"],
    );

    card.append(
      menuEl,
      nameEl,
      h("div", { class: "generator-strip" }, standing.strip.map(square)),
      statsEl,
      h("div", { class: "row" }, [countEl, practiceEl]),
    );
    return card;
  }

  paintAll();

  root.replaceChildren(
    h("h1", {}, ["limitations are in the mind"]),
    renderNewGeneratorForm(go),
    gridEl,
    drawerEl,
  );
}
