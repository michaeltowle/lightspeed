import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import {
  CLIENT_JS,
  FAVICON_BASE64,
  KATEX_CSS,
  KATEX_FONTS_BASE64,
} from "./generated/bundle";

export interface Env {
  ANTHROPIC_API_KEY: string;
  LIGHTSPEED_APP_RECORDS: D1Database;
  // Injected at deploy time by the `deploy` npm script (see package.json).
  // Absent under `wrangler dev`, which renders the badge as "local dev".
  DEPLOY_BRANCH?: string;
  DEPLOYED_AT?: string;
}

const CURRENT_AUTHORING_MODEL_ID = "claude-opus-5";

// Naming a practice type is a one-line job that never touches the maths, so it
// does not need the authoring model. It runs alongside problem generation rather
// than before it, so the only thing its speed protects is the retry path.
const CURRENT_NAMING_MODEL_ID = "claude-haiku-4-5-20251001";

// How hard the model thinks before it answers. "high" is already the API
// default, so naming it here changes nothing today -- it pins the setting so a
// future SDK or API default cannot quietly lower it.
//
// Lower it only with evidence. The walkthroughs are the answer key Mike grades
// himself against, so a cheaper answer that reads right but is wrong is the
// worst failure this app has: it does not look like a bug, it looks like being
// wrong about the maths.
const MODEL_REASONING_EFFORT = "high";

// Problem generation is the one path that *does* need a directive, since the
// output shape is load-bearing.
const PROBLEM_GENERATION_DIRECTIVE = [
  "You generate math practice problems.",
  "",
  "Return exactly the requested number of problems.",
  "Each problem gets three parts: a self-contained statement, a worked",
  "walkthrough, and the final answer on its own. Produce them in that order:",
  "work the problem first and read the answer off the finished steps.",
  "",
  "The walkthrough shows the steps. Its last element must be a <p> beginning",
  "with the word \"Hence\" that restates the final answer, so every walkthrough",
  "lands on its conclusion instead of trailing off.",
  "",
  "The final answer is the result and nothing else -- no working, no restatement",
  "of the question, no lead-in words. It is read at a glance to check an answer",
  "already worked out on paper.",
  "",
  "Check every answer before you commit to it. For an indefinite integral,",
  "differentiate your antiderivative and confirm it returns the integrand. For a",
  "definite integral, confirm the antiderivative the same way, then re-evaluate",
  "it at both bounds and recheck the subtraction. Verify a substitution by",
  "back-substituting to the original variable, and confirm the transformed",
  "limits whenever the bounds changed. For an equation, substitute the solution",
  "back into the original and confirm it holds.",
  "",
  "Sanity-check the result against the problem: the sign, the magnitude, the",
  "domain (nothing divided by zero, no logarithm of a nonpositive quantity, no",
  "root of a negative where the problem is real-valued), and the constant of",
  "integration wherever one belongs. If a check fails, redo the work -- do not",
  "emit an answer you have already found to be wrong.",
  "",
  "Do the checking inside the walkthrough, before the final answer is written.",
  "The final answer restates what the walkthrough already established -- if the",
  "check changes the result, correct the walkthrough rather than letting the two",
  "disagree.",
  "",
  "Emit HTML for all three. Keep the markup minimal: p, br, ul, ol, li, sup,",
  "sub, em, strong. Do not emit script, style, iframe, form, or any attributes.",
  "",
  "Write all mathematics as LaTeX inside $...$ for inline and $$...$$ for",
  "display. Do not use Unicode math symbols or plain-text notation like x^2.",
].join("\n");

// Split out from the set schema so a single problem can be validated on its
// own -- the salvage path below checks recovered problems one at a time.
const PROBLEM_GENERATION_ITEM_SCHEMA = z.object({
  problem_html: z.string().describe("The problem statement, as HTML with $...$ math."),
  // Ordered before the final answer on purpose: the model emits fields in
  // schema order, so working the steps first means the answer is read off
  // finished work rather than guessed at and then justified.
  solution_walkthrough_html: z
    .string()
    .describe(
      'The worked steps, as HTML with $...$ math. The last element must be a <p> starting with "Hence" that restates the final answer.',
    ),
  final_answer_html: z
    .string()
    .describe(
      "The final answer alone, as HTML with $...$ math. No working. Must match the walkthrough's closing line.",
    ),
});

const PROBLEM_GENERATION_SCHEMA = z.object({
  problems: z
    .array(PROBLEM_GENERATION_ITEM_SCHEMA)
    .describe("The generated problems, in the order they should be worked."),
});

// The name is what turns a prompt into something Mike can scan on the dashboard
// and recognise weeks later, so it has to name the *skill*, not echo the request.
const GENERATOR_NAMING_DIRECTIVE = [
  "You name kinds of math practice.",
  "",
  "Given a prompt asking for practice problems, reply with a short label for the",
  "skill it drills -- two to five words, lowercase, no trailing punctuation.",
  "",
  "Name the skill, not the request: \"u-substitution with new limits\", not",
  "\"definite integrals please\". Reply with the label alone and nothing else.",
].join("\n");

const MAX_GENERATOR_NAME_LENGTH = 64;

const MAX_TAG_NAME_LENGTH = 32;
const MAX_TAGS_PER_GENERATOR = 8;

/**
 * Trim, squash and de-duplicate a typed tag list.
 *
 * De-duplication is case-insensitive to match the column's NOCASE uniqueness:
 * without it, "6801, 6801" would be two rows to insert and the second would
 * collide with the first on the way in.
 */
function normalizeTagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of raw) {
    const name = String(entry).replace(/\s+/g, " ").trim().slice(0, MAX_TAG_NAME_LENGTH);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
    if (names.length === MAX_TAGS_PER_GENERATOR) break;
  }
  return names;
}

/** First line of a prompt, squashed to one line -- the fallback when naming fails. */
function firstLineOfPrompt(promptText: string): string {
  const line = promptText.replace(/\s+/g, " ").trim();
  return line.slice(0, MAX_GENERATOR_NAME_LENGTH) || "untitled practice";
}

interface GeneratedProblemRow {
  problem_html: string;
  solution_walkthrough_html: string;
  final_answer_html: string;
}

interface UnsavedImageAttachment {
  base64: string;
  mimeType: string;
  w: number;
  h: number;
  byteSize: number;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// D1 hands BLOBs back as number[] on some paths and ArrayBuffer on others.
function blobToBytes(value: unknown): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : Array.isArray(value)
      ? Uint8Array.from(value)
      : new Uint8Array(value as ArrayBufferLike);
}

function bytesToBase64(value: unknown): string {
  const bytes = blobToBytes(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ai@4 always sends `temperature` (it defaults to 0 rather than being omitted).
// Anthropic removed the sampling params on Opus 4.7 and later, so they must be
// stripped from the wire or the request 400s.
//
// `effort` is a parameter rather than a constant because it is an Opus-5-era
// setting: the naming model predates it and 400s on it, so that call passes null.
const anthropicFor = (env: Env, effort: string | null = MODEL_REASONING_EFFORT) =>
  createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    fetch: async (input, init) => {
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body);
        delete body.temperature;
        delete body.top_p;
        delete body.top_k;
        // ai@4 predates `output_config` and has no way to express effort, so it
        // is injected here alongside the params that have to be stripped.
        if (effort) body.output_config = { ...body.output_config, effort };
        init = { ...init, body: JSON.stringify(body) };
      }
      return fetch(input, init);
    },
  });

const userContent = (
  promptText: string,
  shots: { base64: string; mimeType: string }[],
) => [
  { type: "text" as const, text: promptText.trim() || "(no prompt)" },
  ...shots.map((shot) => ({
    type: "image" as const,
    image: shot.base64,
    mimeType: shot.mimeType,
  })),
];

/**
 * Ask the model for a short name for the kind of practice a prompt asks for.
 *
 * Never throws. A generate that produced good problems must not fail because the
 * label was unavailable -- the prompt's first line is a serviceable name and the
 * dashboard lets it be changed anyway.
 */
async function suggestGeneratorName(env: Env, promptText: string): Promise<string> {
  const fallback = firstLineOfPrompt(promptText);
  if (!promptText.trim()) return fallback;

  try {
    const { text } = await generateText({
      model: anthropicFor(env, null)(CURRENT_NAMING_MODEL_ID),
      maxTokens: 32,
      system: GENERATOR_NAMING_DIRECTIVE,
      messages: [{ role: "user", content: promptText.trim() }],
    });
    const name = text.replace(/\s+/g, " ").trim().slice(0, MAX_GENERATOR_NAME_LENGTH);
    return name || fallback;
  } catch {
    return fallback;
  }
}

async function generateProblemsFromPrompt(
  env: Env,
  promptText: string,
  shots: { base64: string; mimeType: string }[],
  requestedCount: number,
  emphasisProblemsHtml: string[] = [],
): Promise<GeneratedProblemRow[]> {
  // Exemplars are problems this app generated earlier, fed back verbatim. They
  // steer the new set without narrowing it: the original prompt still sets the
  // subject and difficulty, the marks only decide where the weight falls.
  const emphasis = emphasisProblemsHtml.length
    ? [
        "",
        "",
        "These problems from the previous set were marked for further practice.",
        "They are samples of the skill to drill, not problems to reproduce. Hold",
        "the subject and difficulty of the prompt above and weight this set toward",
        "the same skill, but write fresh problems: change the numbers, the setup",
        "and the wording, and vary the structure wherever the skill allows it.",
        "",
        ...emphasisProblemsHtml.map((html, idx) => `${idx + 1}. ${html}`),
        "",
        "Do not restate any of the problems above verbatim. Reuse one only if the",
        "prompt asks for the same problems again, or if the skill admits so few",
        "forms that there is genuinely nothing to vary but the numbers.",
      ].join("\n")
    : "";

  // The provider defaults to 4096 output tokens, which a set of any size runs
  // past: a worked walkthrough with its verification steps costs several
  // hundred tokens, and LaTeX inside JSON pays for every backslash twice.
  //
  // The budget also has to cover reasoning, which is easy to miss. Opus 5 thinks
  // by default -- omitting the `thinking` parameter meant "off" on Opus 4.7 and
  // 4.8, but on Opus 5 it means adaptive -- and those tokens come out of this
  // same cap before a single problem is written. The directive above asks for
  // the most expensive output there is (differentiate back, re-substitute,
  // recheck the bounds), so a thin per-problem allowance is spent on the
  // thinking and the set truncates with nothing to show.
  //
  // 16000 is the ceiling where a non-streaming request is still safe. Past five
  // problems every set sits at it and leans on the salvage below.
  const outputTokenBudget = Math.min(16000, 2000 + requestedCount * 3000);

  try {
    const { object } = await generateObject({
      model: anthropicFor(env)(CURRENT_AUTHORING_MODEL_ID),
      maxTokens: outputTokenBudget,
      schema: PROBLEM_GENERATION_SCHEMA,
      system: PROBLEM_GENERATION_DIRECTIVE,
      messages: [
        {
          role: "user",
          content: userContent(
            `${promptText.trim() || "(no prompt)"}${emphasis}\n\nGenerate exactly ${requestedCount} problems.`,
            shots,
          ),
        },
      ],
    });
    return object.problems;
  } catch (err) {
    // Say which wall was hit. The generic schema-mismatch message reads like the
    // model went off-format, when the reply was merely cut off mid-set.
    if (NoObjectGeneratedError.isInstance(err) && err.finishReason === "length") {
      const salvaged = salvageCompleteProblems(err.text);
      // Every problem that closed before the cut is finished work already paid
      // for, so the set opens with those rather than failing outright. Only a
      // cut landing before the first problem closes leaves nothing to keep.
      if (salvaged.length) return salvaged;
      throw new Error(
        `the model ran out of room before it finished a single problem -- ask for fewer`,
      );
    }
    throw err;
  }
}

/**
 * Pull the complete problems out of a reply the token cap cut short.
 *
 * `generateObject` discards the whole set when the JSON will not parse, but a
 * truncated reply is only broken at its tail -- every problem that closed
 * before the cut is intact. Walk the `problems` array and keep each object
 * whose braces balanced and whose fields still satisfy the schema.
 */
function salvageCompleteProblems(partialJson: string | undefined): GeneratedProblemRow[] {
  if (!partialJson) return [];

  const problemsKeyAt = partialJson.indexOf('"problems"');
  if (problemsKeyAt < 0) return [];
  const arrayStart = partialJson.indexOf("[", problemsKeyAt);
  if (arrayStart < 0) return [];

  const salvaged: GeneratedProblemRow[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = arrayStart + 1; i < partialJson.length; i++) {
    const ch = partialJson[i];

    if (inString) {
      // The payload is mostly LaTeX, so it is mostly backslashes. Escape
      // tracking has to be exact here or the scanner loses the closing quote
      // and reads every brace in the maths as structure.
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          const parsed = PROBLEM_GENERATION_ITEM_SCHEMA.safeParse(
            JSON.parse(partialJson.slice(objectStart, i + 1)),
          );
          if (parsed.success) salvaged.push(parsed.data);
        } catch {
          // A balanced slice that will not parse means the scan has lost its
          // place. The problems already collected are still good; stop there.
          break;
        }
        objectStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }

  return salvaged;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const attrEscape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function indexPageDocument(env: Env): string {
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
  :root { color-scheme: light dark; }
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
    max-width: 52rem;
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
  /* Unscoped on purpose: a generator card's strip is the same square as the
     wall's, so the two always read as one language. */
  .trophy {
    width: 7px;
    height: 7px;
    border-radius: 1px;
    background: rgba(128,128,128,0.30);
  }
  .trophy-right   { background: rgba(120,170,110,0.55); }
  .trophy-wrong   { background: rgba(190,110,100,0.50); }

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

  /* One row per practice type. A table because these are rows of the same few
     facts -- worked, right, last -- and columns let the eye run down one fact
     at a time, which a wall of boxes never allowed. */
  .generator-table {
    width: 100%; border-collapse: collapse; margin: 1.25rem 0 0;
    font-size: 0.85rem;
  }
  .generator-table th {
    text-align: left; font-weight: 500; font-size: 0.68rem; opacity: 0.5;
    padding: 0 0.4rem 0.3rem;
    border-bottom: 1px solid rgba(128,128,128,0.35);
  }
  .generator-table th.col-num { text-align: right; }
  .generator-table td {
    padding: 0.3rem 0.4rem; vertical-align: middle;
    border-bottom: 1px solid rgba(128,128,128,0.18);
  }
  /* The whole row is the selection target, so it has to look like one. */
  .generator-row { cursor: pointer; }
  .generator-row:hover { background: rgba(127,127,127,0.07); }
  .generator-row.is-selected { background: rgba(127,127,127,0.15); }
  .generator-row.is-selected td.generator-name { font-weight: 600; }

  .col-select { width: 1.4rem; }
  .col-select input { margin: 0; accent-color: #b06a2c; }
  .col-strip { width: 8.5rem; }
  .col-menu { width: 1.8rem; position: relative; }
  .col-num {
    text-align: right; white-space: nowrap;
    font-size: 0.75rem; opacity: 0.65; font-variant-numeric: tabular-nums;
  }
  td.generator-name { min-width: 9rem; overflow-wrap: anywhere; }
  /* The phone selects what to practise; it does not tag and it does not read
     the record. Both columns dropped here are authoring surfaces, and between
     them they were squeezing the name -- the one column you actually select on
     -- down to a few characters a line. Filtering survives as the chips above. */
  @media (max-width: 40rem) {
    .generator-table { font-size: 0.78rem; }
    .generator-table th, .generator-table td {
      padding-left: 0.2rem; padding-right: 0.2rem;
    }
    .col-strip, .col-tags { display: none; }
    td.generator-name { min-width: 0; }
  }
  .generator-name-input {
    width: 100%; padding: 0.25rem 0.4rem; font: inherit; font-weight: 600;
    color: inherit; border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    background: rgba(127,127,127,0.04);
  }
  .generator-strip { display: inline-flex; flex-wrap: wrap; gap: 3px; }
  .generator-stats {
    font-size: 0.72rem; opacity: 0.6; font-variant-numeric: tabular-nums;
  }
  .generator-stats.err { color: #c0392b; opacity: 1; }
  .generator-prompt {
    width: 100%; min-height: 6rem; font-size: 0.85rem;
  }

  /* One practice button for the table, acting on whichever row is lit. */
  .practice-launch-control { margin-top: 0.85rem; }
  .practice-launch-control input[type=number] { width: 3.75rem; padding: 0.4rem; }
  .practice-launch-control .practice { font-weight: 600; }

  /* Tags: what class a type belongs to -- a course number, a textbook, an exam.
     The same chip reads the row and, as a button, filters the table. */
  .study-context-tag-cell { cursor: text; min-width: 7rem; }
  .study-context-tag-chip {
    display: inline-block; padding: 0.05rem 0.45rem; margin: 0.1rem 0.2rem 0.1rem 0;
    border: 1px solid rgba(128,128,128,0.4); border-radius: 999px;
    font-size: 0.7rem; opacity: 0.85; white-space: nowrap;
  }
  .study-context-tag-empty { opacity: 0.25; }
  .generator-row:hover .study-context-tag-empty { opacity: 0.6; }
  .study-context-tag-input {
    width: 100%; padding: 0.2rem 0.35rem; font: inherit; font-size: 0.75rem;
    color: inherit; border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    background: rgba(127,127,127,0.04);
  }
  .study-context-tag-filter {
    display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 1.25rem;
  }
  button.study-context-tag-chip {
    cursor: pointer; background: none; color: inherit; padding: 0.12rem 0.6rem;
  }
  button.study-context-tag-chip.is-on {
    opacity: 1; font-weight: 600; border-color: currentColor;
    background: rgba(127,127,127,0.14);
  }

  /* The editor takes a row of its own beneath the one being tuned: a table cell
     is no place to read a screenshot of a maths problem, and the screenshots are
     half of what is being tuned. */
  .prompt-editor-row { cursor: default; }
  .prompt-editor-row:hover { background: none; }
  .prompt-editor-row > td { padding: 0.7rem 0.4rem 1rem; }
  .prompt-editor { display: grid; gap: 0.6rem; align-items: start; }
  .prompt-editor .acts { grid-column: 1 / -1; }
  .prompt-editor .generator-prompt { min-height: 11rem; }
  .prompt-editor.has-shots { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .shots-panel { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
  /* Editing is a two-Dells job and is laid out for them. Narrow just stacks so
     it degrades rather than breaks -- it is not a size being designed for. */
  @media (max-width: 46rem) {
    .prompt-editor.has-shots { grid-template-columns: 1fr; }
  }
  /* Qualified with the tag to outrank the ul.shots li/img rules above, which
     would otherwise hold these to the compose box's 8.5rem letterboxed
     thumbnail -- unreadable, and reading them is the whole point here. */
  ul.generator-shots li { width: auto; max-width: 100%; }
  /* Let the column width be the only real limit. The height cap is a backstop
     for a very tall screenshot, not a size Mike should be squinting at. */
  ul.generator-shots img {
    width: auto; height: auto; max-width: 100%; max-height: 30rem;
  }
  ul.generator-shots a { display: block; }

  /* The menu button is the affordance that works everywhere: right-click is a
     convenience on the Dells, and the iPhone has no such thing. */
  .generator-menu-open {
    padding: 0 0.3rem; line-height: 1.3; font-size: 0.9rem;
    border-color: transparent; background: none; opacity: 0.45;
  }
  .generator-menu-open:hover { opacity: 1; border-color: rgba(128,128,128,0.5); }
  /* Anchored to its own cell, which is the only element in a table row that can
     be relied on to hold an absolutely positioned child. */
  .generator-menu {
    position: absolute; top: 1.8rem; right: 0.2rem; z-index: 3;
    display: flex; flex-direction: column; align-items: stretch;
    border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
    background: Canvas; overflow: hidden; min-width: 9rem;
  }
  .generator-menu button {
    border: 0; border-radius: 0; background: none; text-align: left;
    font-size: 0.8rem; padding: 0.45rem 0.7rem;
  }
  .generator-menu button:hover { background: rgba(127,127,127,0.12); }
  .generator-menu button:disabled { opacity: 0.4; cursor: default; }
  .generator-menu button:disabled:hover { background: none; }

  .archived-drawer { margin-top: 2rem; }
  .archived-drawer > summary {
    cursor: pointer; font-size: 0.75rem; opacity: 0.6;
    padding: 0.25rem 0; user-select: none;
  }
  .archived-drawer .generator-row { opacity: 0.72; }
  .archived-drawer .generator-row:hover { opacity: 1; }

  /* What was worked on each of the last seven days. A fixed rail on the Dells,
     where there is gutter going spare beside a 52rem column; above the table on
     anything narrower, since there is nowhere else for it to be. */
  .rolling-week-practice-ledger {
    position: fixed; left: 1rem; top: 1rem; width: 10rem; z-index: 2;
    padding: 0.55rem 0.65rem; font-size: 0.7rem;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 8px;
    background: rgba(127,127,127,0.06);
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
    display: block; height: 5px; border-radius: 2px;
    background: rgba(128,128,128,0.18);
  }
  .rolling-week-practice-ledger .day-bar {
    display: block; height: 100%; border-radius: 2px;
    background: rgba(120,170,110,0.65);
  }
  .rolling-week-practice-ledger .day-count {
    text-align: right; opacity: 0.8; font-variant-numeric: tabular-nums;
  }
  /* 52rem of column plus a 10rem rail and its margins. Below that the gutter is
     gone and the rail would sit on top of the table. */
  @media (max-width: 76rem) {
    .rolling-week-practice-ledger {
      position: static; width: 100%; max-width: 18rem; margin: 0 0 1.25rem;
    }
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
  .solution-walkthrough { margin-bottom: 0.6rem; }
  .solution-walkthrough > summary {
    cursor: pointer; font-size: 0.75rem; opacity: 0.6;
    padding: 0.25rem 0; user-select: none;
  }
  .walkthrough-body {
    padding: 0.75rem 1.25rem; margin-top: 0.35rem;
    border-left: 3px solid rgba(128,128,128,0.35);
    background: rgba(127,127,127,0.04);
  }
  /* Every walkthrough closes on a "Hence" line restating the answer, so its
     last paragraph is the one the eye should land on. */
  .walkthrough-body > p:last-child {
    font-weight: 600; margin-bottom: 0;
    padding: 0.35rem 0.6rem; border-radius: 4px;
    background: rgba(120,170,110,0.14);
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
  .acts .grade { font-size: 0.75rem; padding: 0.2rem 0.7rem; opacity: 0.65; }
  .acts .grade-on { opacity: 1; font-weight: 600; border-color: currentColor; }
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

  #deploy-badge {
    position: fixed; right: 1rem; bottom: 1rem; z-index: 2;
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
    #deploy-badge { position: static; margin: 2rem 1rem 1rem; display: inline-block; }
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

// Fonts and the favicon are served off "/" behind a query param rather than
// their own paths, so / stays the only route per CLAUDE.md while the browser
// can still cache them.
const IMMUTABLE = "public, max-age=31536000, immutable";

function binaryResponse(base64: string, contentType: string): Response {
  const bytes = base64ToBytes(base64);
  return new Response(bytes, {
    headers: { "content-type": contentType, "cache-control": IMMUTABLE },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/") return new Response("Not found", { status: 404 });

    if (request.method === "GET") {
      const font = url.searchParams.get("font");
      if (font) {
        const data = KATEX_FONTS_BASE64[font];
        if (!data) return new Response("Not found", { status: 404 });
        return binaryResponse(data, "font/woff2");
      }

      // A generator's screenshots are part of its prompt, so they have to be
      // visible while that prompt is being edited. Served here rather than
      // base64'd into the dashboard payload: the browser caches them, and a
      // list of 29 generators does not have to carry megabytes it rarely shows.
      const shot = url.searchParams.get("shot");
      if (shot) {
        const row = await env.LIGHTSPEED_APP_RECORDS
          .prepare(
            `SELECT mime_type, image_bytes
               FROM math_prompt_image_attachment WHERE id = ?`,
          )
          .bind(Number(shot))
          .first<{ mime_type: string; image_bytes: unknown }>();
        if (!row) return new Response("Not found", { status: 404 });
        return new Response(blobToBytes(row.image_bytes), {
          headers: { "content-type": row.mime_type, "cache-control": IMMUTABLE },
        });
      }

      const asset = url.searchParams.get("asset");
      if (asset) {
        const size = asset === "favicon32" ? "32" : asset === "favicon180" ? "180" : null;
        if (!size) return new Response("Not found", { status: 404 });
        return binaryResponse(FAVICON_BASE64[size], "image/png");
      }

      return new Response(indexPageDocument(env), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const db = env.LIGHTSPEED_APP_RECORDS;
    const body = await request.json<{
      action?: string;
      id?: number;
      prompt?: string;
      unsaved_image_attachments?: UnsavedImageAttachment[];
      requested_count?: number;
      named_problem_generator_id?: number;
      name?: string;
      prompt_text?: string;
      study_context_tag_names?: unknown;
      archived?: boolean;
      run_id?: number;
      problem_id?: number;
      attempt_id?: number;
      elapsed_ms?: number;
      skipped?: boolean;
      self_grade?: string;
      marked?: boolean;
    }>();

    try {
      switch (body.action) {
        case "list_named_problem_generators": {
          // No aggregates here on purpose. The trophy payload the page already
          // fetches carries every graded attempt with its generator id, so the
          // counts, the accuracy and the strip are all derived client-side from
          // data that was going over the wire regardless.
          const { results } = await db
            .prepare(
              `SELECT id, name, prompt_text, requested_count, archived_at, created_at
                 FROM named_problem_generator
                ORDER BY id DESC`,
            )
            .all<{ id: number }>();

          // Ids only -- the bytes are fetched one at a time off "/?shot=", and
          // only by the panel that actually shows them.
          const { results: shots } = await db
            .prepare(
              `SELECT id, named_problem_generator_id
                 FROM math_prompt_image_attachment
                ORDER BY named_problem_generator_id, ordinal`,
            )
            .all<{ id: number; named_problem_generator_id: number }>();

          const shotsByGenerator = new Map<number, number[]>();
          for (const row of shots) {
            const list = shotsByGenerator.get(row.named_problem_generator_id);
            if (list) list.push(row.id);
            else shotsByGenerator.set(row.named_problem_generator_id, [row.id]);
          }

          // The whole tag catalogue rides along with the list. It is a handful
          // of short strings, and the dashboard needs all of them anyway to
          // draw the filter and to autocomplete the editor.
          const { results: tags } = await db
            .prepare(`SELECT id, name FROM study_context_tag ORDER BY name`)
            .all<{ id: number; name: string }>();

          const { results: links } = await db
            .prepare(
              `SELECT named_problem_generator_id, study_context_tag_id
                 FROM study_context_tag_membership`,
            )
            .all<{ named_problem_generator_id: number; study_context_tag_id: number }>();

          const tagsByGenerator = new Map<number, number[]>();
          for (const link of links) {
            const list = tagsByGenerator.get(link.named_problem_generator_id);
            if (list) list.push(link.study_context_tag_id);
            else tagsByGenerator.set(link.named_problem_generator_id, [link.study_context_tag_id]);
          }

          return json({
            generators: results.map((row) => ({
              ...row,
              attachment_ids: shotsByGenerator.get(row.id) ?? [],
              study_context_tag_ids: tagsByGenerator.get(row.id) ?? [],
            })),
            study_context_tags: tags,
          });
        }

        case "retag_named_problem_generator": {
          const generatorId = Number(body.id);
          if (!generatorId) return json({ error: "no such generator" }, 404);

          // The whole set arrives at once and replaces what was there. One verb
          // covers adding, removing and renaming, and the client never has to
          // work out which of the three it is doing.
          const names = normalizeTagNames(body.study_context_tag_names ?? []);

          if (names.length) {
            await db.batch(
              names.map((name) =>
                db
                  .prepare(`INSERT OR IGNORE INTO study_context_tag (name) VALUES (?)`)
                  .bind(name),
              ),
            );
          }

          await db
            .prepare(
              `DELETE FROM study_context_tag_membership
                WHERE named_problem_generator_id = ?`,
            )
            .bind(generatorId)
            .run();

          if (names.length) {
            // Bound placeholders, never interpolated names -- the strings are
            // typed by hand and go nowhere near the SQL text.
            const placeholders = names.map(() => "?").join(", ");
            await db
              .prepare(
                `INSERT INTO study_context_tag_membership
                   (named_problem_generator_id, study_context_tag_id)
                 SELECT ?, id FROM study_context_tag WHERE name IN (${placeholders})`,
              )
              .bind(generatorId, ...names)
              .run();
          }

          // A tag exists only as long as something wears it. Clearing the last
          // generator off "Exam 1" retires it rather than leaving it in the
          // filter row with nothing behind it.
          await db
            .prepare(
              `DELETE FROM study_context_tag
                WHERE id NOT IN (SELECT study_context_tag_id FROM study_context_tag_membership)`,
            )
            .run();

          const { results: tags } = await db
            .prepare(`SELECT id, name FROM study_context_tag ORDER BY name`)
            .all<{ id: number; name: string }>();

          const { results: mine } = await db
            .prepare(
              `SELECT study_context_tag_id FROM study_context_tag_membership
                WHERE named_problem_generator_id = ?`,
            )
            .bind(generatorId)
            .all<{ study_context_tag_id: number }>();

          return json({
            study_context_tags: tags,
            study_context_tag_ids: mine.map((row) => row.study_context_tag_id),
          });
        }

        case "rename_named_problem_generator": {
          const name = (body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 64);
          if (!name) return json({ error: "a generator needs a name" }, 400);
          await db
            .prepare(`UPDATE named_problem_generator SET name = ? WHERE id = ?`)
            .bind(name, body.id)
            .run();
          return json({ ok: true, name });
        }

        case "revise_named_problem_generator_prompt": {
          const promptText = (body.prompt_text ?? "").trim();
          if (!promptText) return json({ error: "a generator needs a prompt" }, 400);
          // Revised in place. Sets already worked keep the text that made them in
          // problem_set.prompt_text_as_generated, so editing here cannot rewrite
          // the history of what was practised.
          await db
            .prepare(`UPDATE named_problem_generator SET prompt_text = ? WHERE id = ?`)
            .bind(promptText, body.id)
            .run();
          return json({ ok: true });
        }

        case "archive_named_problem_generator": {
          // One verb both directions, the way a mark is set and cleared.
          await db
            .prepare(
              `UPDATE named_problem_generator
                  SET archived_at = CASE WHEN ?1 = 1
                        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
                WHERE id = ?2`,
            )
            .bind(body.archived ? 1 : 0, body.id)
            .run();
          return json({ ok: true });
        }

        case "suggest_named_problem_generator_name": {
          return json({ name: await suggestGeneratorName(env, body.prompt_text ?? "") });
        }

        case "generate_problems": {
          const requested = Math.max(1, Math.min(40, Number(body.requested_count) || 2));

          // Two ways in, one verb: an existing generator practised again, or a
          // prompt typed fresh, which becomes a generator on the way through.
          if (body.named_problem_generator_id) {
            const generator = await db
              .prepare(
                `SELECT id, prompt_text FROM named_problem_generator WHERE id = ?`,
              )
              .bind(body.named_problem_generator_id)
              .first<{ id: number; prompt_text: string }>();
            if (!generator) return json({ error: "no such generator" }, 404);

            const shots = await attachmentsForGenerator(db, generator.id);
            const generated = await generateProblemsFromPrompt(
              env,
              generator.prompt_text,
              shots,
              requested,
            );
            if (!generated.length) return json({ error: "model returned no problems" }, 502);

            // The card remembers what you last asked it for.
            await db
              .prepare(`UPDATE named_problem_generator SET requested_count = ? WHERE id = ?`)
              .bind(requested, generator.id)
              .run();

            return json(
              await openSetAndRun(
                db,
                generator.id,
                requested,
                generated,
                generator.prompt_text,
              ),
            );
          }

          const shots = body.unsaved_image_attachments ?? [];
          const promptText = body.prompt ?? "";

          // Named alongside the problems rather than before them: naming is a
          // cheap call against a small model and generation is neither, so
          // running them together costs nothing on the clock.
          const [generated, name] = await Promise.all([
            generateProblemsFromPrompt(env, promptText, shots, requested),
            suggestGeneratorName(env, promptText),
          ]);
          if (!generated.length) return json({ error: "model returned no problems" }, 502);

          const generatorId = await insertNamedProblemGenerator(
            db,
            name,
            promptText,
            requested,
            shots,
          );
          return json(
            await openSetAndRun(db, generatorId, requested, generated, promptText),
          );
        }

        case "record_attempt": {
          const inserted = await db
            .prepare(
              `INSERT INTO problem_attempt
                 (math_practice_problem_id, practice_run_id, elapsed_ms, self_grade)
               VALUES (?, ?, ?, ?) RETURNING id`,
            )
            .bind(
              body.problem_id,
              body.run_id,
              Math.max(0, Math.round(Number(body.elapsed_ms) || 0)),
              body.skipped ? "skipped" : null,
            )
            .first<{ id: number }>();
          return json({ attempt_id: inserted!.id });
        }

        case "reveal_answers": {
          // Answers are held back until the run asks for them, rather than
          // shipped with the problems and hidden in the DOM.
          await db
            .prepare(
              `UPDATE practice_run
                  SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND completed_at IS NULL`,
            )
            .bind(body.run_id)
            .run();

          const { results } = await db
            .prepare(
              `SELECT a.id AS attempt_id, p.ordinal, p.problem_html,
                      p.final_answer_html, p.solution_walkthrough_html,
                      a.elapsed_ms, a.self_grade, a.marked_for_further_practice
                 FROM problem_attempt a
                 JOIN math_practice_problem p ON p.id = a.math_practice_problem_id
                WHERE a.practice_run_id = ?
                ORDER BY p.ordinal`,
            )
            .bind(body.run_id)
            .all();
          return json({ rows: results });
        }

        case "grade_attempt": {
          if (!["right", "wrong", "skipped"].includes(String(body.self_grade))) {
            return json({ error: `bad self_grade: ${body.self_grade}` }, 400);
          }
          await db
            .prepare(`UPDATE problem_attempt SET self_grade = ? WHERE id = ?`)
            .bind(body.self_grade, body.attempt_id)
            .run();
          return json({ ok: true });
        }

        case "mark_for_further_practice": {
          await db
            .prepare(
              `UPDATE problem_attempt
                  SET marked_for_further_practice = ?
                WHERE id = ?`,
            )
            .bind(body.marked ? 1 : 0, body.attempt_id)
            .run();
          return json({ ok: true });
        }

        case "further_practice": {
          const origin = await db
            .prepare(
              `SELECT s.id AS problem_set_id, s.named_problem_generator_id,
                      s.requested_count
                 FROM practice_run r
                 JOIN problem_set s ON s.id = r.problem_set_id
                WHERE r.id = ?`,
            )
            .bind(body.run_id)
            .first<{
              problem_set_id: number;
              named_problem_generator_id: number;
              requested_count: number;
            }>();
          if (!origin) return json({ error: "no such run" }, 404);

          const prompt = await db
            .prepare(`SELECT prompt_text FROM named_problem_generator WHERE id = ?`)
            .bind(origin.named_problem_generator_id)
            .first<{ prompt_text: string }>();
          if (!prompt) return json({ error: "no such generator" }, 404);

          // Marks live on the attempt, so the run is the only thing the client
          // has to send -- there is no list of ids to keep in sync.
          const marked = await db
            .prepare(
              `SELECT p.problem_html
                 FROM problem_attempt a
                 JOIN math_practice_problem p ON p.id = a.math_practice_problem_id
                WHERE a.practice_run_id = ? AND a.marked_for_further_practice = 1
                ORDER BY p.ordinal`,
            )
            .bind(body.run_id)
            .all<{ problem_html: string }>();

          const shots = await attachmentsForGenerator(db, origin.named_problem_generator_id);

          const generated = await generateProblemsFromPrompt(
            env,
            prompt.prompt_text,
            shots,
            origin.requested_count,
            // No marks is not an error: it just means "more of the same",
            // which is the old new-set behaviour.
            marked.results.map((row) => row.problem_html),
          );
          if (!generated.length) return json({ error: "model returned no problems" }, 502);

          // Further practice opens a NEW set against the same generator. The set
          // just worked, and its attempts, are left untouched.
          return json(
            await openSetAndRun(
              db,
              origin.named_problem_generator_id,
              origin.requested_count,
              generated,
              prompt.prompt_text,
              origin.problem_set_id,
            ),
          );
        }

        case "trophy_wall": {
          // Every attempt ever answered, oldest first -- the wall is permanent.
          // A square is earned by grading, not by working: back out of a set
          // before the answer page and those attempts stay off the wall.
          // A skip earns nothing either. It is a grade, but it records a problem
          // not attempted, and the wall is a record of problems answered.
          //
          // The generator id rides along so this one payload also feeds the
          // dashboard: every card's strip, count and accuracy is this list
          // bucketed by generator, which is why no card needs its own query.
          const { results } = await db
            .prepare(
              `SELECT a.id, a.created_at, a.self_grade,
                      s.named_problem_generator_id
                 FROM problem_attempt a
                 JOIN practice_run r ON r.id = a.practice_run_id
                 JOIN problem_set s  ON s.id = r.problem_set_id
                WHERE a.self_grade IS NOT NULL
                  AND a.self_grade <> 'skipped'
                ORDER BY a.created_at, a.id`,
            )
            .all();
          return json({ attempts: results });
        }

        default:
          // Explicit, so a typo'd action can't silently spend an API call.
          return json({ error: `unknown action: ${body.action ?? "(none)"}` }, 400);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 502);
    }
  },
};

/** A generator's screenshots, in the shape the model call wants them. */
async function attachmentsForGenerator(
  db: D1Database,
  generatorId: number,
): Promise<{ base64: string; mimeType: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT mime_type, image_bytes
         FROM math_prompt_image_attachment
        WHERE named_problem_generator_id = ?
        ORDER BY ordinal`,
    )
    .bind(generatorId)
    .all();

  return results.map((row: Record<string, unknown>) => ({
    base64: bytesToBase64(row.image_bytes),
    mimeType: String(row.mime_type),
  }));
}

async function insertNamedProblemGenerator(
  db: D1Database,
  name: string,
  promptText: string,
  requestedCount: number,
  shots: UnsavedImageAttachment[],
): Promise<number> {
  const inserted = await db
    .prepare(
      `INSERT INTO named_problem_generator
         (name, prompt_text, requested_count, model_id, system_prompt, reply_text)
       VALUES (?, ?, ?, ?, '', NULL) RETURNING id`,
    )
    .bind(name, promptText, requestedCount, CURRENT_AUTHORING_MODEL_ID)
    .first<{ id: number }>();

  const generatorId = inserted!.id;

  if (shots.length) {
    await db.batch(
      shots.map((shot, idx) =>
        db
          .prepare(
            `INSERT INTO math_prompt_image_attachment
               (named_problem_generator_id, ordinal, mime_type, width_px, height_px, byte_size, image_bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            generatorId,
            idx,
            shot.mimeType,
            shot.w,
            shot.h,
            shot.byteSize,
            base64ToBytes(shot.base64),
          ),
      ),
    );
  }
  return generatorId;
}

/** Persist a generated set, open a run over it, and return the problems without answers. */
async function openSetAndRun(
  db: D1Database,
  generatorId: number,
  requestedCount: number,
  rows: GeneratedProblemRow[],
  promptTextAsGenerated: string,
  precedingProblemSetId: number | null = null,
): Promise<{
  set_id: number;
  run_id: number;
  requested_count: number;
  problems: { id: number; ordinal: number; problem_html: string }[];
}> {
  const set = await db
    .prepare(
      `INSERT INTO problem_set
         (named_problem_generator_id, requested_count, preceding_problem_set_id,
          prompt_text_as_generated)
       VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .bind(generatorId, requestedCount, precedingProblemSetId, promptTextAsGenerated)
    .first<{ id: number }>();
  const setId = set!.id;

  await db.batch(
    rows.map((row, idx) =>
      db
        .prepare(
          `INSERT INTO math_practice_problem
             (problem_set_id, ordinal, problem_html,
              final_answer_html, solution_walkthrough_html)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          setId,
          idx,
          row.problem_html,
          row.final_answer_html,
          row.solution_walkthrough_html,
        ),
    ),
  );

  const run = await db
    .prepare(
      `INSERT INTO practice_run (problem_set_id)
       VALUES (?) RETURNING id`,
    )
    .bind(setId)
    .first<{ id: number }>();

  const { results } = await db
    .prepare(
      `SELECT id, ordinal, problem_html FROM math_practice_problem
        WHERE problem_set_id = ? ORDER BY ordinal`,
    )
    .bind(setId)
    .all<{ id: number; ordinal: number; problem_html: string }>();

  // The count travels back so the run can show that a salvaged set came up
  // short of what was asked for, rather than quietly serving fewer problems.
  return {
    set_id: setId,
    run_id: run!.id,
    requested_count: requestedCount,
    problems: results,
  };
}
