import { CLIENT_JS, KATEX_CSS } from "./generated/bundle";
import { chipColorPaletteCss } from "./tags";
import type { Env } from "./env";

const attrEscape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function indexPageDocument(env: Env): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lightspeed</title>
<link rel="icon" type="image/png" sizes="32x32" href="/?asset=favicon32" />
<link rel="apple-touch-icon" sizes="180x180" href="/?asset=favicon180" />
<style>${KATEX_CSS}</style>
<style>
  :root {
    color-scheme: light dark;
    /* The two panels that float in the bottom-right corner, stacked one above
       the other. They are read as one thing, so they are sized as one thing --
       separate widths, one fixed and one shrink-wrapped to its longest branch
       name, drifted apart by whatever the text happened to be. */
    --corner-panel-width: 11.5rem;
  }
  * { box-sizing: border-box; }
  /* Every display rule below is a class selector, which ties with the browser's
     own [hidden] rule and then wins on order -- so without this, setting .hidden
     on anything laid out with flex or grid does nothing at all. */
  [hidden] { display: none !important; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0;
    line-height: 1.45;
    min-height: 100vh;
  }
  main#app {
    position: relative;
    z-index: 1;
    max-width: 87.9rem;
    margin: 0 auto;
    padding: 1rem 1rem 5rem;
  }
  h1 { font-size: 1rem; font-weight: 600; opacity: 0.6; margin: 0 0 1rem; }

  /* The trophy wall is a fixed layer behind every view, never navigated to. */
  #trophy-wall {
    position: fixed;
    inset: 0;
    z-index: 0;
    padding: 0.75rem;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 3px;
    overflow: hidden;
    pointer-events: none;
  }
  /* Unscoped on purpose: a bank row's strip is the same square as the wall's,
     so the two always read as one language. */
  .trophy {
    width: 7px;
    height: 7px;
    border-radius: 1px;
    background: rgba(128,128,128,0.30);
  }
  .trophy-right   { background: rgba(120,170,110,0.55); }
  .trophy-wrong   { background: rgba(190,110,100,0.50); }
  /* Partial sits between the two, and reads as neither at a glance. */
  .trophy-partial { background: rgba(205,160,80,0.60); }

  form { display: flex; flex-direction: column; gap: 0.75rem; }
  textarea {
    width: 100%; min-height: 5rem; padding: 0.6rem; font: inherit;
    border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    resize: vertical; background: rgba(127,127,127,0.04); color: inherit;
  }
  input[type=number] {
    width: 4.5rem; padding: 0.5rem; font: inherit; color: inherit;
    border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    background: rgba(127,127,127,0.04);
  }
  .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  button {
    padding: 0.55rem 1rem; font: inherit; border-radius: 6px;
    border: 1px solid rgba(128,128,128,0.5);
    background: rgba(127,127,127,0.06); color: inherit; cursor: pointer;
  }
  button#go { font-weight: 600; }
  button:disabled { opacity: 0.45; cursor: default; }

  ul.shots { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
  ul.shots li {
    border: 1px solid rgba(128,128,128,0.4); border-radius: 6px;
    padding: 0.4rem; width: 8.5rem; font-size: 0.75rem;
    background: rgba(127,127,127,0.05);
  }
  ul.shots img { width: 100%; height: 4.5rem; object-fit: contain; display: block; }
  ul.shots .dims { font-variant-numeric: tabular-nums; opacity: 0.75; margin-top: 0.25rem; }
  ul.shots .drop { margin-top: 0.25rem; font-size: 0.75rem; padding: 0.15rem 0.4rem; }

  /* One row per problem. A table because these are rows of the same few facts
     -- worked, right, last -- and columns let the eye run down one fact at a
     time, which a wall of boxes never allowed. */
  .bank-table {
    width: 100%; border-collapse: collapse; margin: 1.25rem 0 0;
    font-size: 0.85rem;
  }
  /* Heading and value centred together, so every column reads as one stack
     rather than a label with its figures drifting off under it. Set on the
     table so a column added later is centred without being told to be. */
  .bank-table th {
    text-align: center; font-weight: 500; font-size: 0.68rem; opacity: 0.5;
    padding: 0 0.4rem 0.3rem;
    border-bottom: 1px solid rgba(128,128,128,0.35);
  }
  .bank-table td {
    padding: 0.3rem 0.4rem; vertical-align: middle; text-align: center;
    border-bottom: 1px solid rgba(128,128,128,0.18);
  }
  /* The opened row is a maths statement and a row of buttons. It borrows the
     table's geometry and nothing else, so the centring stops at its edge. */
  .detail-row td { text-align: left; }
  /* The whole row is the selection target, so it has to look like one. */
  .bank-row { cursor: pointer; }
  .bank-row:hover { background: rgba(127,127,127,0.07); }
  .bank-row.is-ticked { background: rgba(127,127,127,0.15); }
  .bank-row.is-ticked td.problem-name { font-weight: 600; }

  .col-select { width: 1.4rem; }
  .col-select input { margin: 0; accent-color: #b06a2c; }
  .col-label { width: 4.5rem; font-variant-numeric: tabular-nums; opacity: 0.75; }
  /* The narrow reading columns. Tabular figures on the three that are numbers,
     so 3/6 and 12/12 line up down the column instead of wandering. */
  .col-credit, .col-streak { width: 4rem; font-variant-numeric: tabular-nums; }
  /* A streak is the one column that says how the work is going rather than what
     it was, so it is the one that carries colour, read off the last attempt.
     Green and amber rather than green and red: help is how a hard problem gets
     done, not a failure -- it is simply a different claim from having got it
     alone. Weight as well as hue, so the two still part on a screen that eats
     the colour.

     A badge round the figure rather than bare text, and the same pill the tag
     chips are, so the table has one shape for "this is a marked value". The
     ground is the text's own colour thinned down -- the same hue rather than a
     second one chosen to go with it, which is what keeps a pale tint from
     reading as its own category. */
  .col-streak span {
    display: inline-block; padding: 0.05rem 0.45rem; border-radius: 999px;
    font-weight: 600;
  }
  .col-streak .is-last-attempt-unaided {
    color: #2f7d4a; background: rgba(47,125,74,0.13);
  }
  .col-streak .is-last-attempt-helped {
    color: #9a7113; background: rgba(154,113,19,0.15);
  }
  /* The third ground, and the only one that is not a streak in the good sense:
     a run of attempts short of full credit. Red on red, the reds the tag
     palette already uses, so it is the same language as everything else that
     is coloured on this page. */
  .col-streak .is-last-attempt-missed {
    color: #b3303f; background: rgba(179,48,63,0.13);
  }
  @media (prefers-color-scheme: dark) {
    .col-streak .is-last-attempt-unaided {
      color: #79c893; background: rgba(121,200,147,0.15);
    }
    .col-streak .is-last-attempt-helped {
      color: #d9b455; background: rgba(217,180,85,0.15);
    }
    .col-streak .is-last-attempt-missed {
      color: #f0a099; background: rgba(240,160,153,0.15);
    }
  }
  .col-last { width: 6rem; font-variant-numeric: tabular-nums; opacity: 0.8; }
  .col-speed { width: 4rem; opacity: 0.8; }
  .col-flags { width: 6rem; }
  .col-why { min-width: 11rem; opacity: 0.8; }
  .col-menu { width: 1.8rem; position: relative; }
  td.problem-name { min-width: 9rem; overflow-wrap: anywhere; }

  /* A problem with no maneuver table yet is servable but has no answer to
     reveal, so the bank says so rather than letting it surprise you at the end. */
  .awaiting-solve { opacity: 0.5; font-size: 0.7rem; }

  /* Time away from a problem is the thing worth noticing on this page, so it is
     marked on the row itself rather than left to be worked out from a date.
     Two depths of the same beige: a few days off, and a week or more. */
  .bank-row.is-going-cold { background: rgba(214, 196, 158, 0.10); }
  .bank-row.is-going-cold:hover { background: rgba(214, 196, 158, 0.20); }
  .bank-row.is-going-cold.is-ticked { background: rgba(214, 196, 158, 0.30); }
  .bank-row.is-gone-cold { background: rgba(214, 196, 158, 0.26); }
  .bank-row.is-gone-cold:hover { background: rgba(214, 196, 158, 0.38); }
  .bank-row.is-gone-cold.is-ticked { background: rgba(214, 196, 158, 0.48); }
  /* The phone selects what to practise; it does not tag and it does not read the
     record. Six columns at 390px leave the name -- the one column you actually
     select on -- a few characters a line, so everything but the class goes.
     Filtering on any field survives as the chips above the table. */
  @media (max-width: 40rem) {
    .bank-table { font-size: 0.78rem; }
    .bank-table th, .bank-table td {
      padding-left: 0.2rem; padding-right: 0.2rem;
    }
    .col-field-assignment, .col-speed, .col-flags, .col-why {
      display: none;
    }
    td.problem-name { min-width: 0; }
  }
  .problem-name-input {
    width: 100%; padding: 0.25rem 0.4rem; font: inherit; font-weight: 600;
    color: inherit; border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    background: rgba(127,127,127,0.04);
  }
  /* The flags cell, built to hold more than the one flag there is. Pale ground
     and a quiet border, the way a chosen value reads in a multi-select -- and
     deliberately not the tag palette, which means "this problem is filed here"
     rather than "this attempt went like that". */
  .attempt-flag {
    display: inline-block; margin: 1px 2px 1px 0;
    padding: 0.1rem 0.45rem; font-size: 0.7rem; border-radius: 999px;
    background: rgba(127,127,127,0.16); border: 1px solid rgba(128,128,128,0.25);
  }
  .bank-note {
    font-size: 0.72rem; opacity: 0.6; font-variant-numeric: tabular-nums;
  }
  .bank-note.err { color: #c0392b; opacity: 1; }

  /* Only one pane is up at a time, so the page is either for taking problems in
     or for choosing one, never both at once. */
  .tab-strip {
    display: flex; gap: 0.25rem; align-items: flex-end;
    border-bottom: 1px solid rgba(128,128,128,0.35); margin-bottom: 1.1rem;
  }
  .tab {
    padding: 0.4rem 1.2rem; font-size: 0.8rem; cursor: pointer; color: inherit;
    border: 1px solid rgba(128,128,128,0.35); border-bottom: none;
    border-radius: 8px 8px 0 0; background: rgba(127,127,127,0.07);
    opacity: 0.6; margin-bottom: -1px;
  }
  .tab:hover { opacity: 0.9; }
  /* Sitting a pixel low with a background-coloured bottom edge is what makes the
     lit tab read as part of the pane rather than a button above it. */
  .tab.is-on {
    opacity: 1; font-weight: 600;
    background: Canvas; border-bottom: 1px solid Canvas;
  }

  .compose-fields {
    display: grid; gap: 0.7rem; align-items: start;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  }
  .compose-field { display: flex; flex-direction: column; gap: 0.25rem; }
  /* The dimming sits on the label alone. On the column it would multiply down
     into the chips, and no opacity on a child can undo an ancestor's. */
  .compose-field-name { font-size: 0.68rem; opacity: 0.55; }
  .compose-fields input {
    width: 100%; padding: 0.4rem 0.5rem; font: inherit; font-size: 0.85rem;
    color: inherit;
    border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    background: rgba(127,127,127,0.04);
  }
  /* Everything the field already holds, one click away. Typing still works --
     these only edit the box above them. */
  .compose-field-chips { display: flex; flex-wrap: wrap; gap: 0.2rem; }
  .compose-field-chips:empty { display: none; }

  /* One practice button for the bank, acting on every ticked row. */
  .practice-launch-control { margin-top: 0.85rem; }

  /* Assignment reads as plain text. It was already off the palette, and a
     bordered pill with no colour in it is a chip that has stopped doing a
     chip's job -- the outline was the only thing left, drawing a box round a
     name for no reason. Sized with the rest of the table's values, not with
     the class chip beside it, since that is what it is now: a value in a
     column. Kept as the same element so clicking the cell still edits it, and
     kept with a margin so two assignments do not run together. */
  .col-field-assignment .study-context-tag-chip {
    padding: 0; border: none; background: none; border-radius: 0;
    font-size: inherit; margin: 0 0.25rem;
  }

  /* The same chip reads a row and, as a button, filters the table. */
  .study-context-tag-cell { cursor: text; min-width: 5rem; }
  .study-context-tag-chip {
    display: inline-block; padding: 0.05rem 0.45rem; margin: 0.1rem;
    border: 1px solid rgba(128,128,128,0.4); border-radius: 999px;
    font-size: 0.7rem; white-space: nowrap;
  }
  .study-context-tag-empty { opacity: 0.25; }
  .bank-row:hover .study-context-tag-empty { opacity: 0.6; }

  /* Palette, emitted from the table the worker keeps so the two cannot drift. */
${chipColorPaletteCss}
  .study-context-tag-input {
    width: 100%; padding: 0.2rem 0.35rem; font: inherit; font-size: 0.75rem;
    color: inherit; border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    background: rgba(127,127,127,0.04);
  }
  .study-context-tag-filter {
    display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center;
    margin-top: 0.25rem;
  }
  /* Assignment is a dropdown now: one entry per homework outgrew a chip row a
     term at a time, and the class it used to sit beside is the tab. */
  /* Pushed to the far right, away from the tabs: the tab is the choice being
     made, and this only narrows what the tab already picked. Auto margin rather
     than justify-content, so it stays right if anything joins it on the left. */
  .assignment-dropdown {
    margin-left: auto;
    padding: 0.25rem 0.5rem; font: inherit; font-size: 0.8rem; color: inherit;
    border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    background: rgba(127,127,127,0.04); cursor: pointer; max-width: 16rem;
  }

  /* Pinned to the corner rather than set in the flow: authoring is rare, and
     anything in the flow competes with the tabs for the same glance. Above the
     trophy wall, which sits behind everything. */
  .corner-menu { position: fixed; top: 0.6rem; right: 0.8rem; z-index: 40; }
  .corner-menu-button {
    padding: 0.3rem 0.55rem; font-size: 1rem; line-height: 1; cursor: pointer;
    color: inherit; border: 1px solid rgba(128,128,128,0.35); border-radius: 6px;
    background: Canvas; opacity: 0.65;
  }
  .corner-menu-button:hover { opacity: 1; }
  .corner-menu-items {
    position: absolute; top: calc(100% + 0.3rem); right: 0;
    display: flex; flex-direction: column; min-width: 11rem;
    border: 1px solid rgba(128,128,128,0.35); border-radius: 8px;
    background: Canvas; overflow: hidden;
    box-shadow: 0 6px 20px rgba(0,0,0,0.18);
  }
  .corner-menu-items button {
    padding: 0.5rem 0.9rem; font: inherit; font-size: 0.8rem; text-align: left;
    cursor: pointer; color: inherit; border: none; background: none;
  }
  .corner-menu-items button:hover { background: rgba(127,127,127,0.12); }
  /* No background or colour of its own: every chip button carries a palette
     class, and an element-plus-class selector here would outrank it. Being
     chosen shows as a ring, since the fill is already saying which tag it is. */
  button.study-context-tag-chip { cursor: pointer; padding: 0.12rem 0.6rem; }
  button.study-context-tag-chip.is-on {
    font-weight: 600; border-color: currentColor;
  }

  /* The menu button is the affordance that works everywhere: right-click is a
     convenience on the Dells, and the iPhone has no such thing. */
  .row-menu-open {
    padding: 0 0.3rem; line-height: 1.3; font-size: 0.9rem;
    border-color: transparent; background: none; opacity: 0.45;
  }
  .row-menu-open:hover { opacity: 1; border-color: rgba(128,128,128,0.5); }
  /* Anchored to its own cell, which is the only element in a table row that can
     be relied on to hold an absolutely positioned child. */
  .row-menu {
    position: absolute; top: 1.8rem; right: 0.2rem; z-index: 3;
    display: flex; flex-direction: column; align-items: stretch;
    border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    background: Canvas; overflow: hidden; min-width: 9rem;
  }
  .row-menu button {
    border: 0; border-radius: 0; background: none; text-align: left;
    font-size: 0.8rem; padding: 0.45rem 0.7rem;
  }
  .row-menu button:hover { background: rgba(127,127,127,0.12); }
  .row-menu button:disabled { opacity: 0.4; cursor: default; }
  .row-menu button:disabled:hover { background: none; }

  /* What was worked on each of the last seven days. Floated into the bottom
     right corner, stacked above the deploy badge, so the bank table has the
     full width of the page to grow across -- it has columns to spare now and
     no gutter to give up to a rail.

     The offset clears the badge: two lines at 0.72rem/1.6 plus its padding and
     border come to about 3.4rem, and 1rem of that is the badge's own bottom
     margin. Static on a phone, where a floating panel would cover the table it
     is meant to sit beside. */
  .rolling-week-practice-ledger {
    position: fixed; right: 1rem; bottom: 5.1rem; z-index: 2;
    width: var(--corner-panel-width);
    padding: 0.55rem 0.65rem; font-size: 0.7rem;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 8px;
    background: rgba(127,127,127,0.06);

    /* The bar fills, all one tone: every class at the same OKLCH lightness and
       chroma (0.73 / 0.11, pastel), with hues spread so neighbours come apart --
       checked under simulated protan and deutan vision as well as normal. Grey
       is the one step off the tone: at the colours' own lightness it sits too
       close to them to tell apart, so it recedes toward the ground instead. */
    --ledger-class-fill-1: #69afe8;
    --ledger-class-fill-2: #82b976;
    --ledger-class-fill-3: #d98bb8;
    --ledger-class-fill-4: #cca051;
    --ledger-class-fill-5: #a79ce8;
    --ledger-class-fill-6: #e58c84;
    --ledger-no-class-fill: #cecece;
  }
  /* Same hues re-stepped for the dark ground (lightness 0.68), grey darker. */
  @media (prefers-color-scheme: dark) {
    .rolling-week-practice-ledger {
      --ledger-class-fill-1: #599fd8;
      --ledger-class-fill-2: #73a967;
      --ledger-class-fill-3: #c87ca8;
      --ledger-class-fill-4: #bc9041;
      --ledger-class-fill-5: #978cd7;
      --ledger-class-fill-6: #d47c76;
      --ledger-no-class-fill: #636363;
    }
  }
  /* Scoped to the ledger: these names describe its innards, not anything the
     rest of the sheet is entitled to. */
  .rolling-week-practice-ledger .ledger-title { opacity: 0.5; margin-bottom: 0.3rem; }
  .rolling-week-practice-ledger .ledger-day {
    display: grid; grid-template-columns: 4.2rem 1fr 1.2rem;
    align-items: center; gap: 0.3rem; line-height: 1.75;
  }
  .rolling-week-practice-ledger .day-name {
    opacity: 0.7; overflow: hidden; text-overflow: ellipsis;
  }
  .rolling-week-practice-ledger .ledger-day.is-today .day-name {
    opacity: 1; font-weight: 600;
  }
  .rolling-week-practice-ledger .day-track {
    display: block; height: 7px; border-radius: 3px;
    background: rgba(128,128,128,0.11);
  }
  .rolling-week-practice-ledger .day-bar {
    display: flex; height: 100%; border-radius: 3px; overflow: hidden;
  }
  /* One segment per class, its fill set inline from the variables above. */
  .rolling-week-practice-ledger .day-bar > span { flex: 1 1 0; }
  .rolling-week-practice-ledger .day-count {
    text-align: right; opacity: 0.8; font-variant-numeric: tabular-nums;
  }
  .rolling-week-practice-ledger .ledger-key {
    display: flex; flex-wrap: wrap; gap: 0.1rem 0.6rem; margin-top: 0.4rem;
  }
  /* The text is muted, not the entry: faded as a whole, the swatches came out
     paler than the bars they name. */
  .rolling-week-practice-ledger .key-entry {
    display: inline-flex; align-items: center; gap: 0.3rem;
    color: color-mix(in srgb, currentColor 75%, transparent);
  }
  .rolling-week-practice-ledger .key-swatch {
    width: 0.55rem; height: 0.55rem; border-radius: 2px;
  }
  /* Phone only. Above this the panel floats clear in the corner; below it there
     is no corner to spare and it goes back into the flow. */
  @media (max-width: 50rem) {
    .rolling-week-practice-ledger {
      position: static; width: 100%; max-width: 18rem; margin: 0 0 1.25rem;
    }
  }

  /* Said before next, so it sits above it. Quiet until one is chosen: this is a
     judgement offered, never a question the page insists on answering. */
  .speed-report-row { align-items: center; gap: 0.4rem; }
  .speed-report-label { font-size: 0.7rem; opacity: 0.45; }
  .speed-report-button {
    padding: 0.25rem 0.8rem; font-size: 0.78rem; cursor: pointer; color: inherit;
    border: 1px solid rgba(128,128,128,0.4); border-radius: 999px;
    background: rgba(127,127,127,0.05); opacity: 0.65;
  }
  .speed-report-button:hover { opacity: 0.95; }
  .speed-report-button.is-on {
    opacity: 1; font-weight: 600; border-color: currentColor;
    background: rgba(127,127,127,0.18);
  }

  /* One line at rest, growing as it is written into. Full width, because it is
     a sentence and wrapping it into a column would make it harder to read back
     than it was to type. */
  .why-it-went-wrong-box, .editable-per-problem-instructions-to-llm-box {
    width: 100%; margin-top: 0.5rem; padding: 0.35rem 0.5rem;
    font: inherit; font-size: 0.8rem; color: inherit; resize: vertical;
    border: 1px solid rgba(128,128,128,0.35); border-radius: 6px;
    background: rgba(127,127,127,0.04);
  }
  /* Instructions to the model, so it wears a dashed edge -- a different kind
     of writing from the why box above it. */
  .editable-per-problem-instructions-to-llm-box { border-style: dashed; }

  /* Free generate is one box, so it can afford to be a generous one. */
  .free-generate-prompt { margin: 1rem 0 0.5rem; font-size: 0.95rem; }

  /* The instructions, one box per call. Monospace and unwrapped by the page's
     own width, because these are edited a phrase at a time and the eye needs
     to find its place again after every change. */
  .editable-per-job-instructions-to-llm-section { margin: 1.5rem 0 2rem; }
  .editable-per-job-instructions-to-llm-section h2 { font-size: 1rem; margin: 0 0 0.25rem; }
  .editable-per-job-instructions-to-llm-box {
    min-height: 22rem; margin: 0.5rem 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem; line-height: 1.5;
  }
  .editable-per-job-instructions-to-llm-state { font-size: 0.75rem; opacity: 0.6; }
  .editable-per-job-instructions-to-llm-state.is-dirty { opacity: 1; color: #b06a2c; }
  .editable-per-job-instructions-to-llm-narrow-note { display: none; }

  /* Writing instructions to the model is authoring, and authoring is not done
     on the phone: a cramped editor is worse than none. Below this width the
     boxes go and the page says why. */
  @media (max-width: 46rem) {
    .editable-per-job-instructions-to-llm-editor, .editable-per-problem-instructions-to-llm-box { display: none; }
    .editable-per-job-instructions-to-llm-narrow-note { display: block; }
  }

  .lightspeed-motto-line {
    position: fixed; left: 0; right: 0; bottom: 0.6rem; z-index: 2;
    text-align: center; font-size: 0.68rem;
    color: rgba(128,128,128,0.8); pointer-events: none;
  }

  .problem-meta, .meta {
    font-size: 0.75rem; opacity: 0.6; font-variant-numeric: tabular-nums;
    margin-bottom: 0.5rem;
  }
  /* The number off the page, which is what Mike is working from on paper. It
     leads the problem page; the quiz position is kept for the answers page. */
  .textbook-problem-number-label {
    font-weight: 600; opacity: 0.85; font-variant-numeric: tabular-nums;
  }
  .problem-body {
    font-size: 1.15rem; padding: 1.25rem; margin-bottom: 1rem;
    border: 1px solid rgba(128,128,128,0.35); border-radius: 8px;
    background: rgba(127,127,127,0.05);
  }
  .final-answer {
    font-size: 1.35rem; font-weight: 600;
    padding: 0.85rem 1.1rem; margin-bottom: 0.5rem;
    border: 1px solid rgba(120,170,110,0.55); border-radius: 8px;
    background: rgba(120,170,110,0.12);
  }

  /* ---- the maneuver table ------------------------------------------------
     Three columns: what the step is, how to get there in words, and what it
     produces. The result cells are the grading surface -- click one to say you
     got it, click again to say you did not. */
  .maneuver-table {
    width: 100%; border-collapse: collapse; margin: 0.5rem 0 0;
    font-size: 0.85rem;
  }
  .maneuver-table th {
    text-align: left; font-weight: 500; font-size: 0.68rem; opacity: 0.5;
    padding: 0 0.5rem 0.3rem;
    border-bottom: 1px solid rgba(128,128,128,0.35);
  }
  .maneuver-table td {
    padding: 0.45rem 0.5rem; vertical-align: top;
    border-bottom: 1px solid rgba(128,128,128,0.18);
  }
  .maneuver-name { font-weight: 600; width: 11rem; }
  .maneuver-method { opacity: 0.75; }
  /* The last maneuver is the answer, so it carries the weight the old "Hence"
     line used to. */
  .maneuver-table tr:last-child .maneuver-name,
  .maneuver-table tr:last-child .maneuver-result { font-weight: 700; }
  .maneuver-table tr:last-child td { border-bottom: none; }

  .maneuver-result {
    width: 12rem; cursor: pointer; user-select: none;
    border-left: 3px solid transparent;
  }
  .maneuver-result:hover { background: rgba(127,127,127,0.08); }
  .maneuver-result.is-got {
    background: rgba(120,170,110,0.18); border-left-color: rgba(120,170,110,0.75);
  }
  .maneuver-result.is-missed {
    background: rgba(190,110,100,0.16); border-left-color: rgba(190,110,100,0.7);
  }
  /* Grading is what the cells are for on the answers page; on the problem page
     they are only there to be revealed, so the affordance is withdrawn. */
  .maneuver-table.is-help .maneuver-result,
  .maneuver-table.is-view .maneuver-result { cursor: default; }
  .maneuver-table.is-help .maneuver-result:hover,
  .maneuver-table.is-view .maneuver-result:hover { background: none; }

  /* Help on the problem page: the method is readable, every result is not,
     and each can be uncovered on its own so one step can be checked without
     giving up the rest. */
  .maneuver-result-value:not(:empty) { display: block; margin-bottom: 0.3rem; }

  /* The two things a result offers -- see it, go practise it -- as a matched
     pair. Quiet until the row is under the cursor, so a table being read is
     not a table covered in buttons. */
  .maneuver-result-controls {
    display: inline-flex; align-items: center; gap: 0.3rem;
  }
  .maneuver-result-controls button {
    font: inherit; font-size: 0.66rem; letter-spacing: 0.02em;
    line-height: 1.5; padding: 0.1rem 0.6rem; border-radius: 999px;
    border: 1px solid rgba(128,128,128,0.45);
    background: rgba(127,127,127,0.05); color: inherit;
    opacity: 0.55; transition: opacity 120ms ease, background 120ms ease,
    border-color 120ms ease;
  }
  .maneuver-row:hover .maneuver-result-controls button { opacity: 0.95; }
  .maneuver-result-controls button:hover {
    opacity: 1; background: rgba(127,127,127,0.16);
    border-color: rgba(128,128,128,0.75);
  }

  #out {
    margin-top: 1rem; padding: 0.75rem; border-radius: 6px; min-height: 1rem;
    border: 1px solid rgba(128,128,128,0.35);
    background: rgba(127,127,127,0.04);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem; white-space: pre-wrap;
  }
  #out:empty { display: none; }
  #out.err { border-color: #c0392b; color: #c0392b; }

  #saved { list-style: none; margin: 0; padding: 0; }
  #saved > li {
    border: 1px solid rgba(128,128,128,0.35); border-radius: 8px;
    padding: 0.75rem 0.9rem; margin-bottom: 0.75rem;
    background: rgba(127,127,127,0.03);
  }
  .acts {
    display: flex; gap: 0.4rem; align-items: center;
    flex-wrap: wrap; margin-top: 0.6rem;
  }
  .acts .outcome-readout { font-size: 0.75rem; opacity: 0.7; }
  .acts .outcome-readout strong { opacity: 1; }
  .mark {
    display: flex; align-items: center; gap: 0.35rem; margin-left: auto;
    font-size: 0.75rem; opacity: 0.7; cursor: pointer; user-select: none;
  }
  .mark input { accent-color: #b06a2c; margin: 0; }
  #saved > li.marked {
    border-color: rgba(176,106,44,0.65);
    background: rgba(176,106,44,0.06);
  }
  #saved > li.marked .mark { opacity: 1; font-weight: 600; }
  /* An attempt that leaned on the table is still an attempt; it just says so. */
  .took-help { font-size: 0.7rem; opacity: 0.7; color: #b06a2c; }

  #deploy-badge {
    position: fixed; right: 1rem; bottom: 1rem; z-index: 2;
    width: var(--corner-panel-width);
    padding: 0.5rem 0.75rem; border-radius: 8px;
    border: 1px solid rgba(128,128,128,0.3);
    background: rgba(127,127,127,0.10);
    backdrop-filter: blur(6px);
    font-size: 0.72rem; line-height: 1.6; pointer-events: none;
  }
  #deploy-badge .lbl { opacity: 0.55; }
  #deploy-badge .val { color: #b06a2c; font-variant-numeric: tabular-nums; }
  @media (prefers-color-scheme: dark) {
    #deploy-badge .val { color: #d99a5b; }
  }
  @media (max-width: 30rem) {
    /* Off the corner and back into the flow, where it sizes to its own text
       and has nothing to line up with. */
    #deploy-badge {
      position: static; margin: 2rem 1rem 1rem; display: inline-block;
      width: auto;
    }
  }
</style>
</head>
<body>
<main id="app"></main>

<div id="deploy-badge"
     data-at="${attrEscape(env.DEPLOYED_AT ?? "")}"
     data-branch="${attrEscape(env.DEPLOY_BRANCH ?? "")}">
  <div><span class="lbl">deployed</span> <span class="val" id="deploy-when"></span></div>
  <div><span class="lbl">from branch</span> <span class="val" id="deploy-branch"></span></div>
</div>

<script>
(function () {
  var badge = document.getElementById('deploy-badge');
  var at = badge.getAttribute('data-at');
  var branch = badge.getAttribute('data-branch');

  // Rendered in the viewer's local time, so it reads correctly on the phone
  // and both Dells regardless of where the deploy ran.
  function whenText(iso) {
    if (!iso) return 'local dev';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'local dev';
    var mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var h = d.getHours();
    var ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    var m = d.getMinutes();
    return h + ':' + (m < 10 ? '0' + m : m) + ampm + ' on ' + mons[d.getMonth()] + ' ' + d.getDate();
  }

  document.getElementById('deploy-when').textContent = whenText(at);
  document.getElementById('deploy-branch').textContent = branch ? '#' + branch : '#local';
})();
</script>

<script>${CLIENT_JS}</script>
</body>
</html>`;
}
