import { FAVICON_BASE64, KATEX_FONTS_BASE64 } from "./generated/bundle";
import { indexPageDocument } from "./page";
import {
  breakIntoManeuvers,
  buildToOrderFromPrompt,
  transcribeFromScreenshot,
} from "./model";
import {
  inheritTags,
  isStudyContextTagField,
  mandatesFor,
  normalizeTagNames,
  setAllTagFields,
  setTagsForField,
  tagCatalogue,
} from "./tags";
import type { Env } from "./env";

export type { Env };

const MAX_NAME_LENGTH = 64;
const MAX_LABEL_LENGTH = 24;

interface UnsavedScreenshot {
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tidy = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

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

      // Served here rather than base64'd into the bank payload: the browser
      // caches them, and a bank of hundreds of problems must not carry
      // megabytes of screenshots it rarely shows.
      const shot = url.searchParams.get("shot");
      if (shot) {
        const row = await env.LIGHTSPEED_APP_RECORDS
          .prepare(`SELECT mime_type, image_bytes FROM screenshot_of_record WHERE id = ?`)
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
      name?: string;
      note?: string;
      prompt?: string;
      requested_count?: number;
      unsaved_screenshots?: UnsavedScreenshot[];
      screenshot_of_record_ids?: number[];
      problem_ids?: number[];
      field?: unknown;
      study_context_tag_names?: unknown;
      study_context_tags_by_field?: Record<string, unknown>;
      archived?: boolean;
      run_id?: number;
      attempt_id?: number;
      maneuver_id?: number;
      got_it?: boolean;
      elapsed_ms?: number;
      needed_help?: boolean;
      marked?: boolean;
      default_service_style?: string;
    }>();

    try {
      switch (body.action) {
        // ---- the bank ------------------------------------------------------
        case "list_the_bank": {
          // No aggregates here on purpose. The trophy payload the page already
          // fetches carries every graded attempt with its problem id, so the
          // counts, the accuracy and the strip are all derived client-side from
          // data that was going over the wire regardless.
          const { results: problems } = await db
            .prepare(
              `SELECT id, name, textbook_problem_number_label, statement_html,
                      how_this_problem_came_to_be, parent_problem_varied_from,
                      the_maneuver_it_was_isolated_from, text_that_minted_this_problem,
                      default_service_style, broken_into_maneuvers_at,
                      created_at, archived_at
                 FROM math_practice_problem
                ORDER BY id DESC`,
            )
            .all<{ id: number }>();

          const { results: links } = await db
            .prepare(
              `SELECT math_practice_problem_id, study_context_tag_id
                 FROM study_context_tag_membership`,
            )
            .all<{ math_practice_problem_id: number; study_context_tag_id: number }>();

          const { results: shots } = await db
            .prepare(
              `SELECT math_practice_problem_id, screenshot_of_record_id
                 FROM screenshot_of_record_attachment
                ORDER BY math_practice_problem_id, ordinal`,
            )
            .all<{ math_practice_problem_id: number; screenshot_of_record_id: number }>();

          const { results: maneuverCounts } = await db
            .prepare(
              `SELECT math_practice_problem_id, COUNT(*) AS n
                 FROM maneuver GROUP BY math_practice_problem_id`,
            )
            .all<{ math_practice_problem_id: number; n: number }>();

          const bucket = <T>(
            rows: T[],
            key: (row: T) => number,
            value: (row: T) => number,
          ): Map<number, number[]> => {
            const out = new Map<number, number[]>();
            for (const row of rows) {
              const k = key(row);
              const list = out.get(k);
              if (list) list.push(value(row));
              else out.set(k, [value(row)]);
            }
            return out;
          };

          const tagsByProblem = bucket(
            links,
            (r) => r.math_practice_problem_id,
            (r) => r.study_context_tag_id,
          );
          const shotsByProblem = bucket(
            shots,
            (r) => r.math_practice_problem_id,
            (r) => r.screenshot_of_record_id,
          );
          const countByProblem = new Map(
            maneuverCounts.map((r) => [r.math_practice_problem_id, r.n]),
          );

          return json({
            problems: problems.map((row) => ({
              ...row,
              study_context_tag_ids: tagsByProblem.get(row.id) ?? [],
              screenshot_of_record_ids: shotsByProblem.get(row.id) ?? [],
              maneuver_count: countByProblem.get(row.id) ?? 0,
            })),
            study_context_tags: await tagCatalogue(db),
          });
        }

        // Anything with no problem read off it yet. Carried-over screenshots
        // land here, as does anything whose transcription failed -- so a retry
        // is just picking it up again rather than pasting it again.
        case "list_screenshots_awaiting_transcription": {
          const { results } = await db
            .prepare(
              `SELECT id, mime_type, width_px, height_px, byte_size, created_at
                 FROM screenshot_of_record s
                WHERE NOT EXISTS (
                        SELECT 1 FROM screenshot_of_record_attachment a
                         WHERE a.screenshot_of_record_id = s.id)
                ORDER BY id`,
            )
            .all();
          return json({ screenshots: results });
        }

        // ---- intake --------------------------------------------------------
        case "transcribe_from_screenshot": {
          // Saved before the model is asked, so a transcription that fails
          // leaves the screenshots waiting rather than losing them.
          const screenshotIds = body.screenshot_of_record_ids?.length
            ? body.screenshot_of_record_ids
            : await saveScreenshots(db, body.unsaved_screenshots ?? []);
          if (!screenshotIds.length) {
            return json({ error: "no screenshots to read" }, 400);
          }

          const shots = await screenshotsForModel(db, screenshotIds);
          const read = await transcribeFromScreenshot(env, shots, body.note ?? "");
          if (!read.length) return json({ error: "no problems found on that" }, 502);

          const minted: number[] = [];
          for (const problem of read) {
            const id = await insertProblem(db, {
              name: tidy(problem.name, MAX_NAME_LENGTH) || "untitled problem",
              label: tidy(problem.textbook_problem_number_label, MAX_LABEL_LENGTH),
              statementHtml: problem.statement_html,
              origin: "transcribed_from_a_screenshot_of_record",
              mintedWith: body.note ?? "",
            });
            // Every part links to every screenshot it was read off: a problem
            // can span a page break, and the bytes are stored once regardless.
            await db.batch(
              screenshotIds.map((shotId, idx) =>
                db
                  .prepare(
                    `INSERT INTO screenshot_of_record_attachment
                       (math_practice_problem_id, screenshot_of_record_id, ordinal)
                     VALUES (?, ?, ?)`,
                  )
                  .bind(id, shotId, idx),
              ),
            );
            await setAllTagFields(db, id, body.study_context_tags_by_field);
            minted.push(id);
          }
          return json({ problem_ids: minted });
        }

        case "build_to_order_from_prompt": {
          const promptText = (body.prompt ?? "").trim();
          if (!promptText) return json({ error: "a prompt is needed" }, 400);
          const requested = Math.max(1, Math.min(40, Number(body.requested_count) || 2));

          // What this prompt has already produced, so a second ask does not
          // hand back the first ask's problems.
          const { results: already } = await db
            .prepare(
              `SELECT statement_html FROM math_practice_problem
                WHERE text_that_minted_this_problem = ?
                ORDER BY id DESC LIMIT 40`,
            )
            .bind(promptText)
            .all<{ statement_html: string }>();

          const built = await buildToOrderFromPrompt(
            env,
            promptText,
            requested,
            already.map((row) => row.statement_html),
          );
          if (!built.length) return json({ error: "model returned no problems" }, 502);

          const minted: number[] = [];
          for (const problem of built) {
            const id = await insertProblem(db, {
              name: tidy(problem.name, MAX_NAME_LENGTH) || "untitled problem",
              label: "",
              statementHtml: problem.statement_html,
              origin: "built_to_order_from_a_prompt",
              mintedWith: promptText,
            });
            await setAllTagFields(db, id, body.study_context_tags_by_field);
            minted.push(id);
          }
          return json({ problem_ids: minted });
        }

        // One problem at a time, fired in parallel by the client. That is what
        // lets an intake hand back statements immediately and fill in the
        // tables behind it.
        case "break_into_maneuvers": {
          const problem = await db
            .prepare(
              `SELECT id, statement_html FROM math_practice_problem WHERE id = ?`,
            )
            .bind(body.id)
            .first<{ id: number; statement_html: string }>();
          if (!problem) return json({ error: "no such problem" }, 404);

          const maneuvers = await breakIntoManeuvers(
            env,
            problem.statement_html,
            await mandatesFor(db, problem.id),
          );
          if (!maneuvers.length) return json({ error: "model returned no maneuvers" }, 502);

          // Re-breaking replaces the table rather than appending to it, so the
          // action is safe to repeat after a mandate is added.
          await db
            .prepare(`DELETE FROM maneuver WHERE math_practice_problem_id = ?`)
            .bind(problem.id)
            .run();
          await db.batch(
            maneuvers.map((m, idx) =>
              db
                .prepare(
                  `INSERT INTO maneuver
                     (math_practice_problem_id, ordinal, name, method_text, result_html)
                   VALUES (?, ?, ?, ?, ?)`,
                )
                .bind(problem.id, idx, m.name, m.method_text, m.result_html),
            ),
          );
          await db
            .prepare(
              `UPDATE math_practice_problem
                  SET broken_into_maneuvers_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?`,
            )
            .bind(problem.id)
            .run();

          return json({ maneuver_count: maneuvers.length });
        }

        // The table, mid-attempt, because help was asked for. It is fetched
        // here rather than shipped with the problem and hidden in the DOM, so
        // nothing about the answer is on the page until it is actually wanted.
        // The client keeps every result covered and uncovers them one at a time.
        case "peek_at_maneuvers": {
          const { results } = await db
            .prepare(
              `SELECT id, math_practice_problem_id, ordinal, name, method_text, result_html
                 FROM maneuver WHERE math_practice_problem_id = ? ORDER BY ordinal`,
            )
            .bind(body.id)
            .all();
          return json({ maneuvers: results });
        }

        // ---- filing --------------------------------------------------------
        case "retag_problem": {
          if (!body.id) return json({ error: "no such problem" }, 404);
          if (!isStudyContextTagField(body.field)) {
            return json({ error: `bad field: ${String(body.field)}` }, 400);
          }
          await setTagsForField(
            db,
            body.id,
            body.field,
            normalizeTagNames(body.study_context_tag_names ?? []),
          );
          const { results } = await db
            .prepare(
              `SELECT study_context_tag_id FROM study_context_tag_membership
                WHERE math_practice_problem_id = ?`,
            )
            .bind(body.id)
            .all<{ study_context_tag_id: number }>();
          return json({
            study_context_tags: await tagCatalogue(db),
            study_context_tag_ids: results.map((r) => r.study_context_tag_id),
          });
        }

        case "rename_problem": {
          const name = tidy(body.name, MAX_NAME_LENGTH);
          if (!name) return json({ error: "a problem needs a name" }, 400);
          await db
            .prepare(`UPDATE math_practice_problem SET name = ? WHERE id = ?`)
            .bind(name, body.id)
            .run();
          return json({ ok: true, name });
        }

        case "set_default_service_style": {
          if (!["exact", "variant"].includes(String(body.default_service_style))) {
            return json({ error: `bad service style: ${body.default_service_style}` }, 400);
          }
          await db
            .prepare(`UPDATE math_practice_problem SET default_service_style = ? WHERE id = ?`)
            .bind(body.default_service_style, body.id)
            .run();
          return json({ ok: true });
        }

        case "archive_problem": {
          // One verb both directions, the way a mark is set and cleared.
          await db
            .prepare(
              `UPDATE math_practice_problem
                  SET archived_at = CASE WHEN ?1 = 1
                        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
                WHERE id = ?2`,
            )
            .bind(body.archived ? 1 : 0, body.id)
            .run();
          return json({ ok: true });
        }

        // ---- practising ----------------------------------------------------
        case "open_practice_run": {
          const ids = (body.problem_ids ?? []).map(Number).filter(Boolean);
          if (!ids.length) return json({ error: "nothing ticked" }, 400);

          // Read back in the order asked for, and only what actually exists.
          const placeholders = ids.map(() => "?").join(", ");
          const { results: found } = await db
            .prepare(
              `SELECT id, name, textbook_problem_number_label, statement_html,
                      broken_into_maneuvers_at
                 FROM math_practice_problem WHERE id IN (${placeholders})`,
            )
            .bind(...ids)
            .all<{ id: number }>();
          const byId = new Map(found.map((row) => [row.id, row]));
          const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as typeof found;
          if (!ordered.length) return json({ error: "no such problems" }, 404);

          const run = await db
            .prepare(`INSERT INTO practice_run DEFAULT VALUES RETURNING id`)
            .first<{ id: number }>();
          const runId = run!.id;

          // Every attempt row is written up front, so the run needs no
          // membership table of its own and backing out early simply leaves
          // ungraded rows -- which are invisible everywhere.
          await db.batch(
            ordered.map((problem, idx) =>
              db
                .prepare(
                  `INSERT INTO problem_attempt
                     (math_practice_problem_id, practice_run_id, ordinal)
                   VALUES (?, ?, ?)`,
                )
                .bind(problem.id, runId, idx),
            ),
          );

          return json({ run_id: runId, problems: ordered });
        }

        case "record_problem_worked": {
          await db
            .prepare(
              `UPDATE problem_attempt
                  SET elapsed_ms = ?, needed_help_during_attempt = ?
                WHERE practice_run_id = ? AND ordinal = ?`,
            )
            .bind(
              Math.max(0, Math.round(Number(body.elapsed_ms) || 0)),
              body.needed_help ? 1 : 0,
              body.run_id,
              body.id,
            )
            .run();
          return json({ ok: true });
        }

        // The maneuver table is held back until the run asks for it, rather
        // than shipped with the problems and hidden in the DOM.
        case "reveal_answers": {
          await db
            .prepare(
              `UPDATE practice_run
                  SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND completed_at IS NULL`,
            )
            .bind(body.run_id)
            .run();

          const { results: rows } = await db
            .prepare(
              `SELECT a.id AS attempt_id, a.ordinal, a.elapsed_ms, a.outcome,
                      a.needed_help_during_attempt, a.marked_for_further_practice,
                      p.id AS problem_id, p.name, p.textbook_problem_number_label,
                      p.statement_html, p.broken_into_maneuvers_at
                 FROM problem_attempt a
                 JOIN math_practice_problem p ON p.id = a.math_practice_problem_id
                WHERE a.practice_run_id = ?
                ORDER BY a.ordinal`,
            )
            .bind(body.run_id)
            .all<{ attempt_id: number; problem_id: number }>();

          const { results: maneuvers } = await db
            .prepare(
              // Matched with IN rather than a join: the same problem can be
              // worked twice in one run -- deliberately, to drill it -- and a
              // join would hand back its table once per attempt.
              `SELECT m.id, m.math_practice_problem_id, m.ordinal, m.name,
                      m.method_text, m.result_html
                 FROM maneuver m
                WHERE m.math_practice_problem_id IN (
                        SELECT math_practice_problem_id FROM problem_attempt
                         WHERE practice_run_id = ?)
                ORDER BY m.math_practice_problem_id, m.ordinal`,
            )
            .bind(body.run_id)
            .all<{ math_practice_problem_id: number }>();

          const { results: marks } = await db
            .prepare(
              `SELECT c.problem_attempt_id, c.maneuver_id, c.got_it
                 FROM per_maneuver_credit_mark c
                 JOIN problem_attempt a ON a.id = c.problem_attempt_id
                WHERE a.practice_run_id = ?`,
            )
            .bind(body.run_id)
            .all();

          return json({ rows, maneuvers, marks });
        }

        // Grading is per maneuver; the attempt's own outcome is a rollup of
        // these, never set by hand. Partial credit is what that rollup produces
        // rather than a fourth button to press.
        case "mark_maneuver_credit": {
          await db
            .prepare(
              `INSERT INTO per_maneuver_credit_mark (problem_attempt_id, maneuver_id, got_it)
               VALUES (?1, ?2, ?3)
               ON CONFLICT (problem_attempt_id, maneuver_id)
                 DO UPDATE SET got_it = ?3`,
            )
            .bind(body.attempt_id, body.maneuver_id, body.got_it ? 1 : 0)
            .run();
          return json({ outcome: await rollUpOutcome(db, Number(body.attempt_id)) });
        }

        case "clear_maneuver_credit": {
          await db
            .prepare(
              `DELETE FROM per_maneuver_credit_mark
                WHERE problem_attempt_id = ? AND maneuver_id = ?`,
            )
            .bind(body.attempt_id, body.maneuver_id)
            .run();
          return json({ outcome: await rollUpOutcome(db, Number(body.attempt_id)) });
        }

        // A skip is the one outcome that is not a rollup: it records a problem
        // not attempted, so any marks against it are cleared on the way.
        case "skip_attempt": {
          await db
            .prepare(`DELETE FROM per_maneuver_credit_mark WHERE problem_attempt_id = ?`)
            .bind(body.attempt_id)
            .run();
          await db
            .prepare(`UPDATE problem_attempt SET outcome = 'skipped' WHERE id = ?`)
            .bind(body.attempt_id)
            .run();
          return json({ outcome: "skipped" });
        }

        case "mark_for_further_practice": {
          await db
            .prepare(
              `UPDATE problem_attempt SET marked_for_further_practice = ? WHERE id = ?`,
            )
            .bind(body.marked ? 1 : 0, body.attempt_id)
            .run();
          return json({ ok: true });
        }

        case "trophy_wall": {
          // Every attempt ever answered, oldest first -- the wall is permanent.
          // A square is earned by grading, not by working: back out of a run
          // before the answers page and those attempts stay off the wall.
          // A skip earns nothing either. It is an outcome, but it records a
          // problem not attempted, and the wall is a record of problems answered.
          //
          // The problem id rides along so this one payload also feeds the bank:
          // every row's strip and the week's ledger are this list bucketed by
          // problem, which is why no row needs a query of its own.
          const { results } = await db
            .prepare(
              `SELECT id, created_at, outcome, math_practice_problem_id
                 FROM problem_attempt
                WHERE outcome IS NOT NULL AND outcome <> 'skipped'
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

/**
 * Recompute an attempt's outcome from its maneuver marks.
 *
 * An unmarked maneuver counts as not got once anything has been marked, so a
 * half-graded problem reads as partial rather than as right.
 */
async function rollUpOutcome(db: D1Database, attemptId: number): Promise<string | null> {
  const tally = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM maneuver m
                JOIN problem_attempt a ON a.math_practice_problem_id = m.math_practice_problem_id
               WHERE a.id = ?1)                                        AS total,
              (SELECT COUNT(*) FROM per_maneuver_credit_mark
                WHERE problem_attempt_id = ?1)                          AS marked,
              (SELECT COUNT(*) FROM per_maneuver_credit_mark
                WHERE problem_attempt_id = ?1 AND got_it = 1)           AS got`,
    )
    .bind(attemptId)
    .first<{ total: number; marked: number; got: number }>();

  const { total, marked, got } = tally!;
  const outcome = marked === 0 ? null : got === 0 ? "wrong" : got >= total ? "right" : "partial";

  await db
    .prepare(`UPDATE problem_attempt SET outcome = ? WHERE id = ?`)
    .bind(outcome, attemptId)
    .run();
  return outcome;
}

async function insertProblem(
  db: D1Database,
  problem: {
    name: string;
    label: string;
    statementHtml: string;
    origin: string;
    mintedWith: string;
    variedFrom?: number | null;
    isolatedFrom?: number | null;
  },
): Promise<number> {
  const inserted = await db
    .prepare(
      `INSERT INTO math_practice_problem
         (name, textbook_problem_number_label, statement_html,
          how_this_problem_came_to_be, text_that_minted_this_problem,
          parent_problem_varied_from, the_maneuver_it_was_isolated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      problem.name,
      problem.label || null,
      problem.statementHtml,
      problem.origin,
      problem.mintedWith,
      problem.variedFrom ?? null,
      problem.isolatedFrom ?? null,
    )
    .first<{ id: number }>();

  const id = inserted!.id;
  // A problem minted from another inherits its filing, so a variant of a 6801
  // homework problem is still findable under 6801.
  if (problem.variedFrom) await inheritTags(db, problem.variedFrom, id);
  return id;
}

async function saveScreenshots(
  db: D1Database,
  shots: UnsavedScreenshot[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const shot of shots) {
    const row = await db
      .prepare(
        `INSERT INTO screenshot_of_record
           (mime_type, width_px, height_px, byte_size, image_bytes)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(shot.mimeType, shot.w, shot.h, shot.byteSize, base64ToBytes(shot.base64))
      .first<{ id: number }>();
    ids.push(row!.id);
  }
  return ids;
}

/** Screenshot bytes in the shape the model call wants them. */
async function screenshotsForModel(
  db: D1Database,
  ids: number[],
): Promise<{ base64: string; mimeType: string }[]> {
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, mime_type, image_bytes FROM screenshot_of_record
        WHERE id IN (${placeholders}) ORDER BY id`,
    )
    .bind(...ids)
    .all();

  return results.map((row: Record<string, unknown>) => ({
    base64: bytesToBase64(row.image_bytes),
    mimeType: String(row.mime_type),
  }));
}
