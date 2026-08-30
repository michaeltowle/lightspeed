import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText } from "ai";
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

// Blank: authored prompts go to the model with no system instruction, so the
// reply answers the prompt itself. Stored rows keep whatever preamble was in
// force when they were saved, so replay reproduces the original request.
const MODEL_INSTRUCTION_PREAMBLE = "";

// Problem generation is the one path that *does* need a directive, since the
// output shape is load-bearing.
const PROBLEM_GENERATION_DIRECTIVE = [
  "You generate math practice problems.",
  "",
  "Return exactly the requested number of problems.",
  "Each problem gets three parts: a self-contained statement, the final answer",
  "on its own, and a worked walkthrough.",
  "",
  "The final answer is the result and nothing else -- no working, no restatement",
  "of the question, no lead-in words. It is read at a glance to check an answer",
  "already worked out on paper.",
  "",
  "The walkthrough shows the steps. Its last element must be a <p> beginning",
  "with the word \"Hence\" that restates the final answer, so every walkthrough",
  "lands on its conclusion instead of trailing off.",
  "",
  "Emit HTML for all three. Keep the markup minimal: p, br, ul, ol, li, sup,",
  "sub, em, strong. Do not emit script, style, iframe, form, or any attributes.",
  "",
  "Write all mathematics as LaTeX inside $...$ for inline and $$...$$ for",
  "display. Do not use Unicode math symbols or plain-text notation like x^2.",
].join("\n");

const PROBLEM_GENERATION_SCHEMA = z.object({
  problems: z
    .array(
      z.object({
        problem_html: z.string().describe("The problem statement, as HTML with $...$ math."),
        final_answer_html: z
          .string()
          .describe("The final answer alone, as HTML with $...$ math. No working."),
        solution_walkthrough_html: z
          .string()
          .describe(
            'The worked steps, as HTML with $...$ math. The last element must be a <p> starting with "Hence" that restates the final answer.',
          ),
      }),
    )
    .describe("The generated problems, in the order they should be worked."),
});

interface GeneratedProblemRow {
  problem_html: string;
  final_answer_html: string;
  solution_walkthrough_html: string;
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

function bytesToBase64(value: unknown): string {
  // D1 hands BLOBs back as number[] on some paths and ArrayBuffer on others.
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : Array.isArray(value)
        ? Uint8Array.from(value)
        : new Uint8Array(value as ArrayBufferLike);

  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ai@4 always sends `temperature` (it defaults to 0 rather than being omitted).
// Anthropic removed the sampling params on Opus 4.7 and later, so they must be
// stripped from the wire or the request 400s.
const anthropicFor = (env: Env) =>
  createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    fetch: async (input, init) => {
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body);
        delete body.temperature;
        delete body.top_p;
        delete body.top_k;
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

async function callLanguageModel(
  env: Env,
  promptText: string,
  shots: { base64: string; mimeType: string }[],
  systemPrompt: string,
  modelId: string,
): Promise<string> {
  const { text } = await generateText({
    model: anthropicFor(env)(modelId),
    // Omitted entirely when blank -- sending an empty system string is not the
    // same as sending none, and stored rows may legitimately have no preamble.
    ...(systemPrompt.trim() ? { system: systemPrompt } : {}),
    messages: [{ role: "user", content: userContent(promptText, shots) }],
  });
  return text;
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

  const { object } = await generateObject({
    model: anthropicFor(env)(CURRENT_AUTHORING_MODEL_ID),
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
  #trophy-wall .trophy {
    width: 7px;
    height: 7px;
    border-radius: 1px;
    background: rgba(128,128,128,0.30);
  }
  #trophy-wall .trophy-right   { background: rgba(120,170,110,0.55); }
  #trophy-wall .trophy-wrong   { background: rgba(190,110,100,0.50); }
  #trophy-wall .trophy-skipped { background: rgba(150,150,150,0.32); }

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
        case "list": {
          const { results } = await db
            .prepare(
              `SELECT p.id, p.prompt_text, p.model_id, p.reply_text, p.created_at,
                      COUNT(a.id) AS attachment_count
                 FROM authored_math_prompt p
                 LEFT JOIN math_prompt_image_attachment a
                   ON a.authored_math_prompt_id = p.id
                GROUP BY p.id
                ORDER BY p.id DESC
                LIMIT 50`,
            )
            .all();
          return json({ rows: results });
        }

        case "read": {
          const prompt = await db
            .prepare(`SELECT * FROM authored_math_prompt WHERE id = ?`)
            .bind(body.id)
            .first();
          if (!prompt) return json({ error: "no such prompt" }, 404);

          const { results } = await db
            .prepare(
              `SELECT id, ordinal, mime_type, width_px, height_px, byte_size, image_bytes
                 FROM math_prompt_image_attachment
                WHERE authored_math_prompt_id = ?
                ORDER BY ordinal`,
            )
            .bind(body.id)
            .all();

          return json({
            ...prompt,
            attachments: results.map((row: Record<string, unknown>) => ({
              id: row.id,
              ordinal: row.ordinal,
              mime_type: row.mime_type,
              width_px: row.width_px,
              height_px: row.height_px,
              byte_size: row.byte_size,
              base64: bytesToBase64(row.image_bytes),
            })),
          });
        }

        case "replay": {
          const prompt = await db
            .prepare(`SELECT * FROM authored_math_prompt WHERE id = ?`)
            .bind(body.id)
            .first<{ prompt_text: string; model_id: string; system_prompt: string }>();
          if (!prompt) return json({ error: "no such prompt" }, 404);

          const { results } = await db
            .prepare(
              `SELECT mime_type, image_bytes
                 FROM math_prompt_image_attachment
                WHERE authored_math_prompt_id = ?
                ORDER BY ordinal`,
            )
            .bind(body.id)
            .all();

          // Replayed against the stored model_id and system_prompt, not the
          // current ones, so an old prompt reproduces its original request.
          const reply = await callLanguageModel(
            env,
            prompt.prompt_text,
            results.map((row: Record<string, unknown>) => ({
              base64: bytesToBase64(row.image_bytes),
              mimeType: String(row.mime_type),
            })),
            prompt.system_prompt,
            prompt.model_id,
          );
          return json({ reply });
        }

        case "author_and_save": {
          const shots = body.unsaved_image_attachments ?? [];
          const promptText = body.prompt ?? "";
          const reply = await callLanguageModel(
            env,
            promptText,
            shots,
            MODEL_INSTRUCTION_PREAMBLE,
            CURRENT_AUTHORING_MODEL_ID,
          );
          const promptId = await insertAuthoredPrompt(db, promptText, reply, shots);
          return json({ id: promptId, reply });
        }

        case "generate_problems": {
          const shots = body.unsaved_image_attachments ?? [];
          const promptText = body.prompt ?? "";
          const requested = Math.max(1, Math.min(40, Number(body.requested_count) || 10));

          const generated = await generateProblemsFromPrompt(
            env,
            promptText,
            shots,
            requested,
          );
          if (!generated.length) return json({ error: "model returned no problems" }, 502);

          const promptId = await insertAuthoredPrompt(db, promptText, null, shots);
          return json(await openSetAndRun(db, promptId, requested, generated));
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
              `SELECT s.id AS problem_set_id, s.authored_math_prompt_id,
                      s.requested_count
                 FROM practice_run r
                 JOIN problem_set s ON s.id = r.problem_set_id
                WHERE r.id = ?`,
            )
            .bind(body.run_id)
            .first<{
              problem_set_id: number;
              authored_math_prompt_id: number;
              requested_count: number;
            }>();
          if (!origin) return json({ error: "no such run" }, 404);

          const prompt = await db
            .prepare(`SELECT prompt_text FROM authored_math_prompt WHERE id = ?`)
            .bind(origin.authored_math_prompt_id)
            .first<{ prompt_text: string }>();
          if (!prompt) return json({ error: "no such prompt" }, 404);

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

          const { results: shots } = await db
            .prepare(
              `SELECT mime_type, image_bytes
                 FROM math_prompt_image_attachment
                WHERE authored_math_prompt_id = ?
                ORDER BY ordinal`,
            )
            .bind(origin.authored_math_prompt_id)
            .all();

          const generated = await generateProblemsFromPrompt(
            env,
            prompt.prompt_text,
            shots.map((row: Record<string, unknown>) => ({
              base64: bytesToBase64(row.image_bytes),
              mimeType: String(row.mime_type),
            })),
            origin.requested_count,
            // No marks is not an error: it just means "more of the same",
            // which is the old new-set behaviour.
            marked.results.map((row) => row.problem_html),
          );
          if (!generated.length) return json({ error: "model returned no problems" }, 502);

          // Further practice opens a NEW set against the same prompt. The set
          // just worked, and its attempts, are left untouched.
          return json(
            await openSetAndRun(
              db,
              origin.authored_math_prompt_id,
              origin.requested_count,
              generated,
              origin.problem_set_id,
            ),
          );
        }

        case "trophy_wall": {
          // Every attempt ever, oldest first -- the wall is permanent.
          const { results } = await db
            .prepare(
              `SELECT id, created_at, self_grade
                 FROM problem_attempt
                ORDER BY created_at, id`,
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

async function insertAuthoredPrompt(
  db: D1Database,
  promptText: string,
  reply: string | null,
  shots: UnsavedImageAttachment[],
): Promise<number> {
  const inserted = await db
    .prepare(
      `INSERT INTO authored_math_prompt (prompt_text, model_id, system_prompt, reply_text)
       VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .bind(promptText, CURRENT_AUTHORING_MODEL_ID, MODEL_INSTRUCTION_PREAMBLE, reply)
    .first<{ id: number }>();

  const promptId = inserted!.id;

  if (shots.length) {
    await db.batch(
      shots.map((shot, idx) =>
        db
          .prepare(
            `INSERT INTO math_prompt_image_attachment
               (authored_math_prompt_id, ordinal, mime_type, width_px, height_px, byte_size, image_bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            promptId,
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
  return promptId;
}

/** Persist a generated set, open a run over it, and return the problems without answers. */
async function openSetAndRun(
  db: D1Database,
  promptId: number,
  requestedCount: number,
  rows: GeneratedProblemRow[],
  precedingProblemSetId: number | null = null,
): Promise<{
  set_id: number;
  run_id: number;
  problems: { id: number; ordinal: number; problem_html: string }[];
}> {
  const set = await db
    .prepare(
      `INSERT INTO problem_set
         (authored_math_prompt_id, requested_count, preceding_problem_set_id)
       VALUES (?, ?, ?) RETURNING id`,
    )
    .bind(promptId, requestedCount, precedingProblemSetId)
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

  return { set_id: setId, run_id: run!.id, problems: results };
}
