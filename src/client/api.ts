import type {
  AnswerRow,
  AttemptOutcome,
  DefaultServiceStyle,
  Maneuver,
  MathPracticeProblem,
  PerManeuverCreditMark,
  ServedProblem,
  StudyContextTag,
  StudyContextTagField,
  Trophy,
  UnsavedScreenshot,
} from "./types";

// Every call is a POST to "/" carrying an action -- CLAUDE.md keeps / as the
// only route, so the action lives in the body rather than the path.
async function post<T>(payload: Record<string, unknown>): Promise<T> {
  const res = await fetch("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const wireScreenshots = (shots: UnsavedScreenshot[]) =>
  shots.map((s) => ({
    base64: s.base64,
    mimeType: s.mimeType,
    w: s.w,
    h: s.h,
    byteSize: s.byteSize,
  }));

// ---- the bank ---------------------------------------------------------------

export const listTheBank = () =>
  post<{ problems: MathPracticeProblem[]; study_context_tags: StudyContextTag[] }>({
    action: "list_the_bank",
  });

export const trophyWall = () => post<{ attempts: Trophy[] }>({ action: "trophy_wall" });

// ---- intake -----------------------------------------------------------------

/**
 * Read the problems off each pasted screenshot. One call per screenshot, fanned
 * out server-side, so a lettered question comes back as one problem per part.
 * A screenshot nothing could be read off is dropped and counted rather than
 * failing the rest of the paste.
 */
export const transcribeFromScreenshot = (
  shots: UnsavedScreenshot[],
  note: string,
  tagsByField: Partial<Record<StudyContextTagField, string[]>>,
) =>
  post<{ problem_ids: number[]; unreadable_screenshot_count: number }>({
    action: "transcribe_from_screenshot",
    note,
    study_context_tags_by_field: tagsByField,
    unsaved_screenshots: wireScreenshots(shots),
  });

export const buildToOrderFromPrompt = (
  prompt: string,
  requestedCount: number,
  tagsByField: Partial<Record<StudyContextTagField, string[]>>,
) =>
  post<{ problem_ids: number[] }>({
    action: "build_to_order_from_prompt",
    prompt,
    requested_count: requestedCount,
    study_context_tags_by_field: tagsByField,
  });

/**
 * Problems that drill one maneuver on its own, minted and filed under the
 * class and assignment of the problem the step was taken from.
 *
 * A step carrying no skill of its own comes back as an error rather than as
 * padding -- see the directive behind it.
 */
export const drillOneManeuver = (maneuverId: number, count: number) =>
  post<{ problem_ids: number[]; maneuver_name: string }>({
    action: "drill_one_maneuver",
    maneuver_id: maneuverId,
    requested_drill_count: count,
  });

/** One problem's table. Fired per problem so an intake need not wait on them. */
export const breakIntoManeuvers = (problemId: number) =>
  post<{ maneuver_count: number }>({ action: "break_into_maneuvers", id: problemId });

// ---- filing -----------------------------------------------------------------

/**
 * Replace one field's tags on a problem, leaving the other fields alone.
 * Names, not ids: one the field has not seen is created on the way through.
 * Returns the catalogue as it then stands.
 */
export const retagProblem = (
  id: number,
  field: StudyContextTagField,
  names: string[],
) =>
  post<{ study_context_tags: StudyContextTag[]; study_context_tag_ids: number[] }>({
    action: "retag_problem",
    id,
    field,
    study_context_tag_names: names,
  });

export const renameProblem = (id: number, name: string) =>
  post<{ ok: true; name: string }>({ action: "rename_problem", id, name });

/** Free text of Mike's own. Saving an empty one clears it. */
export const setProblemComment = (id: number, comment: string) =>
  post<{ ok: true }>({ action: "set_problem_comment", id, comment });

export const setDefaultServiceStyle = (id: number, style: DefaultServiceStyle) =>
  post<{ ok: true }>({ action: "set_default_service_style", id, default_service_style: style });

/** Both directions, the way a mark is set and cleared. */
export const archiveProblem = (id: number, archived: boolean) =>
  post<{ ok: true }>({ action: "archive_problem", id, archived });

// ---- practising -------------------------------------------------------------

/** Ticked problems become a run. Exact serve: no model call, so this is instant. */
export const openPracticeRun = (problemIds: number[]) =>
  post<{ run_id: number; problems: ServedProblem[] }>({
    action: "open_practice_run",
    problem_ids: problemIds,
  });

export const recordProblemWorked = (
  runId: number,
  ordinal: number,
  elapsedMs: number,
  neededHelp: boolean,
) =>
  post<{ ok: true }>({
    action: "record_problem_worked",
    run_id: runId,
    id: ordinal,
    elapsed_ms: elapsedMs,
    needed_help: neededHelp,
  });

/**
 * The table, fetched mid-attempt because help was asked for. Nothing arrives
 * until it is asked for, which is the same bargain the answers page makes --
 * the client hides the results until each is uncovered.
 */
export const peekAtManeuvers = (problemId: number) =>
  post<{ maneuvers: Maneuver[] }>({ action: "peek_at_maneuvers", id: problemId });

export const revealAnswers = (runId: number) =>
  post<{ rows: AnswerRow[]; maneuvers: Maneuver[]; marks: PerManeuverCreditMark[] }>({
    action: "reveal_answers",
    run_id: runId,
  });

/** Grading is per maneuver; the attempt's outcome comes back as a rollup. */
export const markManeuverCredit = (attemptId: number, maneuverId: number, gotIt: boolean) =>
  post<{ outcome: AttemptOutcome | null }>({
    action: "mark_maneuver_credit",
    attempt_id: attemptId,
    maneuver_id: maneuverId,
    got_it: gotIt,
  });

export const clearManeuverCredit = (attemptId: number, maneuverId: number) =>
  post<{ outcome: AttemptOutcome | null }>({
    action: "clear_maneuver_credit",
    attempt_id: attemptId,
    maneuver_id: maneuverId,
  });

export const skipAttempt = (attemptId: number) =>
  post<{ outcome: AttemptOutcome }>({ action: "skip_attempt", attempt_id: attemptId });

export const markForFurtherPractice = (attemptId: number, marked: boolean) =>
  post<{ ok: true }>({
    action: "mark_for_further_practice",
    attempt_id: attemptId,
    marked,
  });
