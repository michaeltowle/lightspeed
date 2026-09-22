import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { Env } from "./env";

export const CURRENT_AUTHORING_MODEL_ID = "claude-opus-5";

// How hard the model thinks before it answers. "high" is the API default, so
// this pins the setting rather than raising it -- but it only bites at all
// because the forced tool call is swapped out below. While the object was
// being asked for as a tool call, every table came back with
// `thinking_tokens: 0` and this constant did nothing.
//
// Lower it only with evidence. The maneuver tables are the answer key Mike
// grades himself against, so a cheaper answer that reads right but is wrong is
// the worst failure this app has: it does not look like a bug, it looks like
// being wrong about the maths.
const MODEL_REASONING_EFFORT = "high";

// The words each call is given live in the database, where Mike edits them --
// see editable-per-job-instructions-to-llm.ts. What stays here is the shape of what comes back,
// which the page is built on and structured output enforces: field names,
// types, and the few facts the code itself leans on. A description that says
// how something should be written, rather than what it is, belongs in the
// instructions, where it can be changed without a deploy.

const STATEMENT_ITEM_SCHEMA = z.object({
  name: z.string().describe("A short name for the problem."),
  statement_html: z
    .string()
    .describe("The problem statement, as HTML with mathematics as LaTeX in $...$."),
});

const TRANSCRIBED_ITEM_SCHEMA = STATEMENT_ITEM_SCHEMA.extend({
  textbook_problem_number_label: z
    .string()
    .describe("The number the page gives it. Empty if unnumbered."),
});

const TRANSCRIPTION_SCHEMA = z.object({
  problems: z.array(TRANSCRIBED_ITEM_SCHEMA).describe("In the order they appear on the page."),
});

const BUILD_TO_ORDER_SCHEMA = z.object({
  problems: z.array(STATEMENT_ITEM_SCHEMA).describe("In the order to work them."),
});

// "The last one is the final answer" stays here because the code depends on
// it: the answers page shows the last result as the answer, and getting the
// last row is getting the whole problem.
const MANEUVER_SCHEMA = z.object({
  maneuvers: z
    .array(
      z.object({
        name: z.string().describe("What the step is."),
        method_text: z.string().describe("How to arrive at it."),
        result_html: z
          .string()
          .describe("What the step produces, as HTML with mathematics as LaTeX in $...$."),
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

export interface SolvedManeuver {
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
      // Set when the request was rewritten, naming the tool the reply has to
      // impersonate on the way back.
      let askedAs: string | null = null;
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body);
        delete body.temperature;
        delete body.top_p;
        delete body.top_k;
        // ai@4 predates `output_config` and has no way to express effort, so it
        // is injected here alongside the params that have to be stripped.
        if (effort) body.output_config = { ...body.output_config, effort };

        // The swap that makes the model think at all.
        //
        // `generateObject` asks for the object as a forced tool call, and a
        // forced tool call turns thinking off on Opus 5 -- measured, not
        // assumed: the same solve returns `thinking_tokens: 0` as a tool call
        // and ~350 as structured output. Tables written with no reasoning are
        // exactly the failure described above the effort constant. Asking the
        // provider for json mode is not an option; it throws
        // UnsupportedFunctionalityError. So the schema goes out as
        // `output_config.format` instead, and the reply is dressed back up as
        // the tool call ai@4 is waiting for.
        const forcedName: unknown =
          body.tool_choice?.type === "tool" ? body.tool_choice.name : null;
        const forcedTool =
          typeof forcedName === "string" && Array.isArray(body.tools)
            ? body.tools.find(
                (tool: { name?: unknown }) => tool.name === forcedName,
              )
            : undefined;
        if (forcedTool) {
          askedAs = forcedName as string;
          body.output_config = {
            ...body.output_config,
            format: { type: "json_schema", schema: forcedTool.input_schema },
          };
          delete body.tools;
          delete body.tool_choice;
        } else if (Array.isArray(body.tools)) {
          // Nothing sends an unforced tool today. If something ever does, it
          // skips the swap above, so keep the arguments schema-valid the only
          // other way the API offers.
          body.tools = body.tools.map((tool: Record<string, unknown>) => ({
            ...tool,
            strict: true,
          }));
        }
        init = { ...init, body: JSON.stringify(body) };
      }

      const response = await fetch(input, init);
      if (!askedAs || !response.ok) return response;

      // Structured output arrives as a text block. ai@4 is looking for a
      // tool_use block, so hand it one. A body that does not parse is passed
      // through untouched: generateObject then fails the way it always did,
      // which is louder and more honest than inventing an empty object.
      const payload = (await response.json()) as {
        content?: { type?: string; text?: string }[];
        [key: string]: unknown;
      };
      const emitted = (payload.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      let parsed: unknown;
      try {
        parsed = JSON.parse(emitted);
      } catch {
        return new Response(JSON.stringify(payload), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          ...payload,
          content: [
            { type: "tool_use", id: `toolu_${askedAs}`, name: askedAs, input: parsed },
          ],
          stop_reason: "tool_use",
        }),
        { status: response.status, headers: { "content-type": "application/json" } },
      );
    },
  });

/**
 * Read every problem off one screenshot.
 *
 * One screenshot per call: the route fans a paste out rather than handing the
 * whole page over at once, because a call that sees one question is the one
 * that reliably enumerates its lettered parts.
 */
export async function transcribeFromScreenshot(
  env: Env,
  instructions: string,
  shots: { base64: string; mimeType: string }[],
  note: string,
): Promise<TranscribedProblem[]> {
  const { object } = await generateObject({
    model: anthropicFor(env)(CURRENT_AUTHORING_MODEL_ID),
    // Statements are cheap next to worked solutions, but a dense page of parts
    // still runs long, and reasoning comes out of this same cap.
    maxTokens: 16000,
    schema: TRANSCRIPTION_SCHEMA,
    system: instructions,
    messages: [
      {
        role: "user",
        content: [
          ...(note.trim() ? [{ type: "text" as const, text: note.trim() }] : []),
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

/**
 * Find or invent problems to a typed request. How many is the request's to
 * say, or the instructions' where it does not.
 *
 * The bank goes with it, so a request can lean on what is already there --
 * "like 2.3(a) but discrete" has to be able to find 2.3(a). Reference material
 * first and the request last, which is the order a long prompt is read best in.
 */
export async function buildToOrderFromPrompt(
  env: Env,
  instructions: string,
  promptText: string,
  bank: {
    name: string;
    label: string | null;
    filedUnder: { field: string; name: string }[];
    statementHtml: string;
  }[],
  problemsNotToRepeatHtml: string[] = [],
): Promise<BuiltProblem[]> {
  const attr = (value: string) => value.replace(/"/g, "&quot;");
  const bankBlock = bank.length
    ? [
        "The problem bank, for reference:",
        "",
        "<bank>",
        ...bank.map((p) => {
          const attrs = [
            `name="${attr(p.name)}"`,
            ...(p.label ? [`number="${attr(p.label)}"`] : []),
            ...p.filedUnder.map((t) => `${t.field}="${attr(t.name)}"`),
          ].join(" ");
          return `<problem ${attrs}>\n${p.statementHtml}\n</problem>`;
        }),
        "</bank>",
        "",
        "",
      ].join("\n")
    : "";

  // What this same request has already handed out. Without it the model
  // drifts back to the same few problems every time it is asked. What to do
  // with them is the instructions' business; this only labels them.
  const history = problemsNotToRepeatHtml.length
    ? [
        "Already written for this request:",
        "",
        ...problemsNotToRepeatHtml.map((html, idx) => `${idx + 1}. ${html}`),
        "",
        "",
      ].join("\n")
    : "";

  const { object } = await generateObject({
    model: anthropicFor(env)(CURRENT_AUTHORING_MODEL_ID),
    maxTokens: 16000,
    schema: BUILD_TO_ORDER_SCHEMA,
    system: instructions,
    messages: [
      { role: "user", content: `${bankBlock}${history}The request:\n\n${promptText.trim()}` },
    ],
  });
  return object.problems;
}

/**
 * Solve one problem and lay the solution out as its maneuver table.

 *
 * One problem per call, which is what removes the old token-budget guesswork:
 * a whole set used to share a single 16k cap and truncate mid-solution. One
 * problem never comes close.
 *
 * The problem goes out with what it is filed under and whatever was written
 * for it alone, labelled and nothing more. A convention scoped to a class is a
 * sentence in the instructions ("for 6801, ..."), and this is what lets that
 * sentence find the problems it means.
 */
export async function solveStepByStep(
  env: Env,
  instructions: string,
  problem: {
    statementHtml: string;
    filedUnder: { field: string; name: string }[];
    editablePerProblemInstructionsToLlm: string;
    // The table being replaced. Sent only alongside words written for this
    // problem, since that is when there is something to say about it -- "step
    // 3 is wrong" needs a step 3 -- and otherwise it would only pull the new
    // solution back toward the old one.
    previousManeuvers: SolvedManeuver[];
  },
): Promise<SolvedManeuver[]> {
  const filed = problem.filedUnder.length
    ? `\n\nFiled under: ${problem.filedUnder.map((t) => `${t.field} ${t.name}`).join(", ")}.`
    : "";
  const ownWords = problem.editablePerProblemInstructionsToLlm.trim();
  const previous =
    ownWords && problem.previousManeuvers.length
      ? [
          "",
          "",
          "The solution this problem had before, which is being redone:",
          "",
          ...problem.previousManeuvers.map((m, idx) =>
            [
              `${idx + 1}. ${m.name}`,
              `   method: ${m.method_text}`,
              `   result: ${m.result_html}`,
            ].join("\n"),
          ),
        ].join("\n")
      : "";
  const own = ownWords ? `\n\nInstructions for this problem:\n\n${ownWords}` : "";

  const { object } = await generateObject({
    model: anthropicFor(env)(CURRENT_AUTHORING_MODEL_ID),
    maxTokens: 16000,
    schema: MANEUVER_SCHEMA,
    system: instructions,
    messages: [{ role: "user", content: `${problem.statementHtml}${filed}${previous}${own}` }],
  });

  // The database rejects an empty result outright, so a stray narration row
  // would fail the whole insert and lose the good maneuvers with it. Dropping
  // it here keeps the table rather than the row.
  return object.maneuvers.filter((m) => m.result_html.trim().length > 0);
}
