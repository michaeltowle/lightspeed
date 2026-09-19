import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { Env } from "./env";

export const CURRENT_AUTHORING_MODEL_ID = "claude-opus-5";

// How hard the model thinks before it answers. "high" is already the API
// default, so naming it here changes nothing today -- it pins the setting so a
// future SDK or API default cannot quietly lower it.
//
// Lower it only with evidence. The maneuver tables are the answer key Mike
// grades himself against, so a cheaper answer that reads right but is wrong is
// the worst failure this app has: it does not look like a bug, it looks like
// being wrong about the maths.
const MODEL_REASONING_EFFORT = "high";

// Shared by everything that emits a problem statement or a result cell.
const MARKUP_RULES = [
  "Emit HTML. Keep the markup minimal: p, br, ul, ol, li, sup, sub, em, strong.",
  "Do not emit script, style, iframe, form, or any attributes.",
  "",
  "Write all mathematics as LaTeX inside $...$ for inline and $$...$$ for",
  "display. Do not use Unicode math symbols or plain-text notation like x^2.",
].join("\n");

const NAME_RULE = [
  "Give each problem a short name: two to six words naming what it asks,",
  'lowercase, no trailing punctuation. "find the pdf of Y = X cubed", never',
  '"problem 2.1(a)" and never a restatement of the whole question.',
].join("\n");

/**
 * Reading problems off a screenshot.
 *
 * The splitting rule is the load-bearing part. A lettered question is several
 * problems, and each has to survive being served on its own weeks later with
 * the rest of the page nowhere in sight -- so the shared stem is folded in
 * rather than referred back to.
 */
const TRANSCRIPTION_DIRECTIVE = [
  "You read math problems off screenshots.",
  "",
  "Split what you see into atomic problems: one problem per thing that can be",
  "worked on its own. A question with lettered parts (a), (b), (c) is that many",
  "problems, not one.",
  "",
  "Every problem you return must be workable with nothing else in view. Where",
  "the page states something once and the parts rely on it -- a shared setup, a",
  "shared instruction, a distribution given at the top -- fold it into each part",
  'that needs it, in full. Never write "as in part (a)" or "from the stem above"',
  "or anything else that points outside the problem you are writing.",
  "",
  "Give each problem the number the page gives it, exactly as printed:",
  '"2.1(a)", "2.4", "1.55". If nothing on the page numbers it, leave it empty.',
  "",
  NAME_RULE,
  "",
  "Transcribe faithfully. Do not correct, simplify, restate or improve the",
  "mathematics, and do not solve anything. Statements only.",
  "",
  MARKUP_RULES,
].join("\n");

/** Writing fresh problems to a typed prompt, with no screenshot to work from. */
const BUILD_TO_ORDER_DIRECTIVE = [
  "You write math practice problems.",
  "",
  "Return exactly the requested number of problems. Each is a self-contained",
  "statement that can be worked with nothing else in view.",
  "",
  NAME_RULE,
  "",
  "Vary them: change the numbers, the setup and the wording, and vary the",
  "structure wherever the skill allows it. Do not return one problem several",
  "times over with the numbers changed unless the skill genuinely admits",
  "nothing else.",
  "",
  "Do not solve anything. Statements only.",
  "",
  MARKUP_RULES,
].join("\n");

/**
 * Breaking a problem into the table Mike grades himself against.
 *
 * Two constraints carry the whole idea. A maneuver must produce something, or
 * the table stops being a ladder of results and becomes prose with cells drawn
 * round it -- the database enforces this too. And the method column must be
 * free of mathematics, because that column is what the problem page can show as
 * help without handing over the answer.
 */
const BREAK_INTO_MANEUVERS_DIRECTIVE = [
  "You break a worked math problem into maneuvers.",
  "",
  "A maneuver is one step that produces something. Return them in the order",
  "they are carried out. The last maneuver is the final answer.",
  "",
  "Each maneuver has three parts:",
  "",
  '  name    what the step is, as an imperative: "find the support",',
  '          "calculate the rejection region". Two to six words.',
  "  method  how to arrive at it, in plain English. No mathematics, no symbols,",
  "          no formulae, no variable names -- describe the move in words a",
  "          reader could follow before picking up a pen.",
  "  result  the value or expression the step produces.",
  "",
  "A step with nothing to put in `result` is not a maneuver. Do not return",
  'narration, orientation, or "now we consider the other case" -- if it does not',
  "produce a value or an expression, fold it into the `method` of the step it",
  "belongs to.",
  "",
  "Work the problem and check it before you write any of this down. For an",
  "indefinite integral, differentiate your antiderivative and confirm it returns",
  "the integrand. For a definite integral, confirm the antiderivative the same",
  "way, then re-evaluate it at both bounds and recheck the subtraction. Verify a",
  "substitution by back-substituting to the original variable, and confirm the",
  "transformed limits wherever the bounds changed. For an equation, substitute",
  "the solution back into the original and confirm it holds. For a density,",
  "confirm it is nonnegative and integrates to one over its support.",
  "",
  "Sanity-check the result against the problem: the sign, the magnitude, the",
  "domain (nothing divided by zero, no logarithm of a nonpositive quantity, no",
  "root of a negative where the problem is real-valued), and the constant of",
  "integration wherever one belongs. If a check fails, redo the work -- do not",
  "emit an answer you have already found to be wrong.",
  "",
  "That checking is yours to do before you answer. It does not become maneuvers",
  "of its own unless the problem actually asks for the check, in which case it",
  "is part of the method like any other step.",
  "",
  "`name` and `method` are plain text, not HTML, and carry no mathematics.",
  "`result` is HTML: minimal markup (sup, sub, em, strong) with all mathematics",
  "as LaTeX inside $...$. No Unicode math symbols, no plain-text notation.",
].join("\n");

const STATEMENT_ITEM_SCHEMA = z.object({
  name: z.string().describe("Two to six lowercase words naming what the problem asks."),
  statement_html: z
    .string()
    .describe("The problem statement, as HTML with $...$ math. Self-contained."),
});

const TRANSCRIBED_ITEM_SCHEMA = STATEMENT_ITEM_SCHEMA.extend({
  textbook_problem_number_label: z
    .string()
    .describe('The number the page gives it, e.g. "2.1(a)". Empty if unnumbered.'),
});

const TRANSCRIPTION_SCHEMA = z.object({
  problems: z
    .array(TRANSCRIBED_ITEM_SCHEMA)
    .describe("One entry per atomic problem, in the order they appear on the page."),
});

const BUILD_TO_ORDER_SCHEMA = z.object({
  problems: z.array(STATEMENT_ITEM_SCHEMA).describe("The problems, in the order to work them."),
});

const MANEUVER_SCHEMA = z.object({
  maneuvers: z
    .array(
      z.object({
        name: z.string().describe("Imperative, two to six words. Plain text."),
        method_text: z
          .string()
          .describe("Plain English, no mathematics or symbols whatsoever."),
        result_html: z
          .string()
          .describe("The value or expression produced, as HTML with $...$ math. Never empty."),
      }),
    )
    .describe("In order. The last one is the final answer."),
});

export interface TranscribedProblem {
  name: string;
  textbook_problem_number_label: string;
  statement_html: string;
}

export interface BuiltProblem {
  name: string;
  statement_html: string;
}

export interface BrokenManeuver {
  name: string;
  method_text: string;
  result_html: string;
}

// ai@4 always sends `temperature` (it defaults to 0 rather than being omitted).
// Anthropic removed the sampling params on Opus 4.7 and later, so they must be
// stripped from the wire or the request 400s.
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

/**
 * Read every problem off a set of screenshots.
 *
 * Statements only, so this stays a vision-and-transcription job rather than a
 * solving one -- which is what lets a pasted screenshot become practisable in
 * one wait instead of one wait per problem.
 */
export async function transcribeFromScreenshot(
  env: Env,
  shots: { base64: string; mimeType: string }[],
  note: string,
): Promise<TranscribedProblem[]> {
  const { object } = await generateObject({
    model: anthropicFor(env)(CURRENT_AUTHORING_MODEL_ID),
    // Statements are cheap next to worked solutions, but a dense page of parts
    // still runs long, and reasoning comes out of this same cap.
    maxTokens: 8000,
    schema: TRANSCRIPTION_SCHEMA,
    system: TRANSCRIPTION_DIRECTIVE,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text" as const,
            text: note.trim()
              ? `${note.trim()}\n\nRead every problem off the attached screenshots.`
              : "Read every problem off the attached screenshots.",
          },
          ...shots.map((shot) => ({
            type: "image" as const,
            image: shot.base64,
            mimeType: shot.mimeType,
          })),
        ],
      },
    ],
  });
  return object.problems;
}

/** Write fresh problems to a typed prompt. */
export async function buildToOrderFromPrompt(
  env: Env,
  promptText: string,
  requestedCount: number,
  problemsNotToRepeatHtml: string[] = [],
): Promise<BuiltProblem[]> {
  // What this prompt has already handed out. A record of what has been
  // practised, not samples to steer by -- without it the model drifts back to
  // the same few problems every time it is asked.
  const history = problemsNotToRepeatHtml.length
    ? [
        "",
        "",
        "These problems have already been given for this prompt. They say what",
        "not to repeat; the prompt above alone sets the subject and difficulty.",
        "",
        ...problemsNotToRepeatHtml.map((html, idx) => `${idx + 1}. ${html}`),
        "",
        "Do not restate any of them verbatim. If the skill admits so few forms",
        "that only the numbers can change, change the numbers.",
      ].join("\n")
    : "";

  const { object } = await generateObject({
    model: anthropicFor(env)(CURRENT_AUTHORING_MODEL_ID),
    maxTokens: 8000,
    schema: BUILD_TO_ORDER_SCHEMA,
    system: BUILD_TO_ORDER_DIRECTIVE,
    messages: [
      {
        role: "user",
        content: `${promptText.trim() || "(no prompt)"}${history}\n\nWrite exactly ${requestedCount} problems.`,
      },
    ],
  });
  return object.problems;
}

/**
 * Break one problem into its maneuver table.
 *
 * One problem per call, which is what removes the old token-budget guesswork:
 * a whole set used to share a single 16k cap and truncate mid-solution, needing
 * a hand-written salvage scanner to keep the problems that had finished. One
 * problem never comes close.
 */
export async function breakIntoManeuvers(
  env: Env,
  statementHtml: string,
  mandates: string[],
): Promise<BrokenManeuver[]> {
  const house = mandates.length
    ? [
        "",
        "",
        "Standing conventions for this problem. Follow them even where another",
        "route would be shorter, and let each one show as the maneuver it is",
        "rather than folding it into a neighbouring step:",
        "",
        ...mandates.map((rule, idx) => `${idx + 1}. ${rule}`),
      ].join("\n")
    : "";

  const { object } = await generateObject({
    model: anthropicFor(env)(CURRENT_AUTHORING_MODEL_ID),
    maxTokens: 8000,
    schema: MANEUVER_SCHEMA,
    system: BREAK_INTO_MANEUVERS_DIRECTIVE,
    messages: [
      {
        role: "user",
        content: `${statementHtml}${house}\n\nBreak this into maneuvers.`,
      },
    ],
  });

  // The database rejects an empty result outright, so a stray narration row
  // would fail the whole insert and lose the good maneuvers with it. Dropping
  // it here keeps the table rather than the row.
  return object.maneuvers.filter((m) => m.result_html.trim().length > 0);
}
