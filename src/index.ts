import { FAVICON_BASE64, KATEX_FONTS_BASE64 } from "./generated/bundle";
import { indexPageDocument } from "./page";
import {
  breakIntoManeuvers,
  buildToOrderFromPrompt,
  drillOneManeuver,
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
const MAX_COMMENT_LENGTH = 280;

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

// For bytes whose URL can outlive what it points at. Private because a
// screenshot is Mike's homework, not a public asset.
const REVALIDATED = "private, max-age=0, must-revalidate";

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
      //
      // Validated rather than immutable, because a screenshot id is not a
      // permanent name for one image. Ids restart whenever the table is
      // emptied and its sequence reset, so id 1 can be one page today and a
      // different one tomorrow -- and a year-long immutable cache would go on
      // showing the first long after it was deleted. The tag is the row's own
      // creation stamp, so a reused id misses and a genuine re-view 304s.
      const shot = url.searchParams.get("shot");
      if (shot) {
        const row = await env.LIGHTSPEED_APP_RECORDS
          .prepare(
            `SELECT mime_type, created_at, image_bytes
               FROM screenshot_of_record WHERE id = ?`,
          )
          .bind(Number(shot))
          .first<{ mime_type: string; created_at: string; image_bytes: unknown }>();
        if (!row) return new Response("Not found", { status: 404 });

        const etag = `"${shot}-${row.created_at}"`;
        const headers = {
          "content-type": row.mime_type,
          "cache-control": REVALIDATED,
          etag,
        };
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(blobToBytes(row.image_bytes), { headers });
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
      comment?: string;
      note?: string;
      prompt?: string;
      requested_count?: number;
      unsaved_screenshots?: UnsavedScreenshot[];
      problem_ids?: number[];
      field?: unknown;
      study_context_tag_names?: unknown;
      study_context_tags_by_field?: Record<string, unknown>;
      archived?: boolean;
      run_id?: number;
      attempt_id?: number;
      maneuver_id?: number;
      requested_drill_count?: number;
      got_it?: boolean;
      elapsed_ms?: number;
      needed_help?: boolean;
      marked?: boolean;
      default_service_style?: string;
      self_reported_working_speed?: string;
      why_this_one_went_wrong?: string;
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
                      comment, default_service_style, broken_into_maneuvers_at,
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

        // ---- intake --------------------------------------------------------
        case "transcribe_from_screenshot": {
          const screenshotIds = await saveScreenshots(db, body.unsaved_screenshots ?? []);
          if (!screenshotIds.length) {
            return json({ error: "no screenshots to read" }, 400);
          }

          // One call per screenshot, fired together.
          //
          // A page of five questions used to share one call, and one budget,
          // with every lettered part of every question -- which is where the
          // model consolidated: 2.1(a), (b), (c) came back as a single problem
          // rather than three. A call that sees one question enumerates its
          // parts. It is the same lesson break_into_maneuvers learned when a
          // whole set shared one cap.
          //
          // It also settles what a problem is attached to. Every problem used
          // to link to every screenshot in the paste; now it links to the one
          // it was actually read off.
          const reads = await Promise.all(
            screenshotIds.map(async (shotId) => {
              try {
                const shots = await screenshotsForModel(db, [shotId]);
                const problems = await transcribeFromScreenshot(env, shots, body.note ?? "");
                return { shotId, problems };
              } catch {
                return { shotId, problems: [] };
              }
            }),
          );

          // A screenshot only earns its place by having a problem read off it.
          // Nothing lists an unattached one any more, so one that came back
          // empty drops its bytes rather than sitting in the table unreachable
          // -- re-pasting is the retry.
          const unread = reads.filter((read) => !read.problems.length);
          if (unread.length) {
            await forgetScreenshots(db, unread.map((read) => read.shotId));
          }
          if (unread.length === reads.length) {
            return json({ error: "no problems found on that" }, 502);
          }

          const minted: number[] = [];
          for (const { shotId, problems } of reads) {
            for (const problem of problems) {
              const id = await insertProblem(db, {
                name: tidy(problem.name, MAX_NAME_LENGTH) || "untitled problem",
                label: tidy(problem.textbook_problem_number_label, MAX_LABEL_LENGTH),
                statementHtml: problem.statement_html,
                origin: "transcribed_from_a_screenshot_of_record",
                mintedWith: body.note ?? "",
              });
              await db
                .prepare(
                  `INSERT INTO screenshot_of_record_attachment
                     (math_practice_problem_id, screenshot_of_record_id, ordinal)
                   VALUES (?, ?, 0)`,
                )
                .bind(id, shotId)
                .run();
              await setAllTagFields(db, id, body.study_context_tags_by_field);
              minted.push(id);
            }
          }
          // A paste of five crops is five calls, so one failing need not cost
          // the other four.
          return json({
            problem_ids: minted,
            unreadable_screenshot_count: unread.length,
          });
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
        // Problems that isolate one step, minted like any other -- the problem
        // stays the atom, and where it came from is a column. The bank already
        // hides anything isolated from a maneuver, so drills never crowd it.
        case "drill_one_maneuver": {
          const maneuver = await db
            .prepare(
              `SELECT m.id, m.name, m.method_text, m.result_html,
                      m.math_practice_problem_id AS parent_id,
                      p.statement_html AS parent_statement_html
                 FROM maneuver m
                 JOIN math_practice_problem p
                   ON p.id = m.math_practice_problem_id
                WHERE m.id = ?`,
            )
            .bind(body.maneuver_id)
            .first<{
              id: number;
              name: string;
              method_text: string;
              result_html: string;
              parent_id: number;
              parent_statement_html: string;
            }>();
          if (!maneuver) return json({ error: "no such maneuver" }, 404);

          const wanted = Math.max(1, Math.min(10, Number(body.requested_drill_count) || 3));

          // What this step has already been drilled with, so a second press
          // does not hand back the first press's problems.
          const { results: already } = await db
            .prepare(
              `SELECT statement_html FROM math_practice_problem
                WHERE the_maneuver_it_was_isolated_from = ?
                ORDER BY id DESC LIMIT 20`,
            )
            .bind(maneuver.id)
            .all<{ statement_html: string }>();

          const written = await drillOneManeuver(
            env,
            maneuver,
            maneuver.parent_statement_html,
            wanted,
            already.map((row) => row.statement_html),
          );
          // Empty is a verdict, not a failure: the directive lets the model
          // refuse a step that carries no skill.
          if (!written.length) {
            return json({ error: "this step cannot be drilled on its own" }, 422);
          }

          const minted: number[] = [];
          for (const problem of written) {
            const id = await insertProblem(db, {
              name: tidy(problem.name, MAX_NAME_LENGTH) || "untitled drill",
              label: "",
              statementHtml: problem.statement_html,
              origin: "isolated_from_one_maneuver",
              mintedWith: maneuver.name,
              isolatedFrom: maneuver.id,
            });
            // The class and the assignment come down from the problem the step
            // was taken from, so a drill still counts where its parent counts.
            await inheritTags(db, maneuver.parent_id, id);
            minted.push(id);
          }
          return json({
            problem_ids: minted,
            maneuver_name: maneuver.name,
          });
        }

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

        case "set_problem_comment": {
          // Cleared by saving an empty one, so there is no separate verb for
          // taking a comment off.
          await db
            .prepare(`UPDATE math_practice_problem SET comment = ? WHERE id = ?`)
            .bind(tidy(body.comment, MAX_COMMENT_LENGTH), body.id)
            .run();
          return json({ ok: true });
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

          // Read back so each served problem carries its attempt, which is what
          // lets it be skipped from the page it is worked on rather than only
          // from the answers page afterwards.
          const { results: attempts } = await db
            .prepare(
              `SELECT id, ordinal FROM problem_attempt
                WHERE practice_run_id = ? ORDER BY ordinal`,
            )
            .bind(runId)
            .all<{ id: number; ordinal: number }>();
          const attemptByOrdinal = new Map(attempts.map((a) => [a.ordinal, a.id]));

          return json({
            run_id: runId,
            problems: ordered.map((problem, idx) => ({
              ...problem,
              problem_attempt_id: attemptByOrdinal.get(idx) ?? null,
            })),
          });
        }

        case "record_problem_worked": {
          // Never compulsory, so anything that is not one of the three words is
          // no answer rather than a bad one.
          const speed = ["slow", "mid", "fast"].includes(String(body.self_reported_working_speed))
            ? String(body.self_reported_working_speed)
            : null;
          await db
            .prepare(
              `UPDATE problem_attempt
                  SET elapsed_ms = ?, needed_help_during_attempt = ?,
                      self_reported_working_speed = ?
                WHERE practice_run_id = ? AND ordinal = ?`,
            )
            .bind(
              Math.max(0, Math.round(Number(body.elapsed_ms) || 0)),
              body.needed_help ? 1 : 0,
              speed,
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
                      a.count_of_maneuvers_got, a.count_of_maneuvers_faced,
                      a.why_this_one_went_wrong,
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
          return json(await rollUpOutcome(db, Number(body.attempt_id)));
        }

        case "clear_maneuver_credit": {
          await db
            .prepare(
              `DELETE FROM per_maneuver_credit_mark
                WHERE problem_attempt_id = ? AND maneuver_id = ?`,
            )
            .bind(body.attempt_id, body.maneuver_id)
            .run();
          return json(await rollUpOutcome(db, Number(body.attempt_id)));
        }

        // A skip is the one outcome that is not a rollup: it records a problem
        // not attempted, so any marks against it are cleared on the way.
        case "skip_attempt": {
          await db
            .prepare(`DELETE FROM per_maneuver_credit_mark WHERE problem_attempt_id = ?`)
            .bind(body.attempt_id)
            .run();
          // Passed over, so nothing it might have said about the working
          // stands: no interval, no speed, no help, no credit, no post-mortem.
          // A skip is the absence of an attempt, not a bad one.
          await db
            .prepare(
              `UPDATE problem_attempt
                  SET outcome = 'skipped', elapsed_ms = NULL,
                      needed_help_during_attempt = 0,
                      self_reported_working_speed = NULL,
                      why_this_one_went_wrong = '',
                      count_of_maneuvers_got = NULL,
                      count_of_maneuvers_faced = NULL
                WHERE id = ?`,
            )
            .bind(body.attempt_id)
            .run();
          return json({ outcome: "skipped" });
        }

        // Written at the answers page, once the maneuver marks have shown where
        // it went wrong. Its own action for the same reason set_problem_comment
        // is: prose is typed and saved on a rhythm of its own, not folded into
        // whatever else the page happened to be sending.
        case "set_why_this_one_went_wrong": {
          await db
            .prepare(`UPDATE problem_attempt SET why_this_one_went_wrong = ? WHERE id = ?`)
            .bind(tidy(String(body.why_this_one_went_wrong ?? ""), 400), body.attempt_id)
            .run();
          return json({ ok: true });
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
              `SELECT id, created_at, outcome, math_practice_problem_id,
                      count_of_maneuvers_got, count_of_maneuvers_faced,
                      needed_help_during_attempt, self_reported_working_speed,
                      why_this_one_went_wrong
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
 * Recompute an attempt's outcome from its maneuver marks, and hand back the
 * marks it was computed from.
 *
 * An unmarked maneuver counts as not got once anything has been marked, so a
 * half-graded problem reads as partial rather than as right.
 *
 * The marks travel with the outcome because the two must never be read from
 * different moments: one grading click can change rows other than the one
 * clicked, and a click that fails to save changes none of them. Returning both
 * together is what lets the page show colours and a readout that agree.
 */
async function rollUpOutcome(
  db: D1Database,
  attemptId: number,
): Promise<{ outcome: string | null; marks: Record<string, unknown>[] }> {
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

  // The fraction is written here because here is where it is already counted.
  // Stored rather than recomputed later: re-breaking a problem replaces its
  // maneuver table, and a denominator read off the new one would restate work
  // already graded against the old.
  await db
    .prepare(
      `UPDATE problem_attempt
          SET outcome = ?, count_of_maneuvers_got = ?, count_of_maneuvers_faced = ?
        WHERE id = ?`,
    )
    .bind(outcome, outcome === null ? null : got, outcome === null ? null : total, attemptId)
    .run();

  const { results: marks } = await db
    .prepare(
      `SELECT problem_attempt_id, maneuver_id, got_it
         FROM per_maneuver_credit_mark
        WHERE problem_attempt_id = ?`,
    )
    .bind(attemptId)
    .all<Record<string, unknown>>();

  return { outcome, marks };
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

/** Drop screenshots nothing was read off, so none sit unreachable. */
async function forgetScreenshots(db: D1Database, ids: number[]): Promise<void> {
  await db.batch(
    ids.map((id) => db.prepare(`DELETE FROM screenshot_of_record WHERE id = ?`).bind(id)),
  );
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
