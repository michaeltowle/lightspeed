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
  LlmJob,
  EditablePerJobInstructionsToLlm,
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

/**
 * Free generate: find or invent problems to a typed request. The request says
 * how many, and the bank goes along as reference so it can point at what is
 * already there.
 */
export const buildToOrderFromPrompt = (prompt: string) =>
  post<{ problem_ids: number[] }>({ action: "build_to_order_from_prompt", prompt });

/** One problem's table. Fired per problem so an intake need not wait on them. */
export const solveStepByStep = (problemId: number) =>
  post<{ maneuver_count: number }>({ action: "solve_step_by_step", id: problemId });

/**
 * Every problem's table at once, reported as each lands. A failure costs that
 * problem its table rather than the lot -- the statements are already saved,
 * and it can be solved again from the bank or the answers page.
 */
export async function solveEachStepByStep(
  problemIds: number[],
  onProgress: (done: number, failed: number) => void,
): Promise<{ failed: number }> {
  let done = 0;
  let failed = 0;
  onProgress(done, failed);
  await Promise.all(
    problemIds.map(async (id) => {
      try {
        await solveStepByStep(id);
      } catch {
        failed += 1;
      } finally {
        done += 1;
        onProgress(done, failed);
      }
    }),
  );
  return { failed };
}

// ---- the instructions -------------------------------------------------------

export const listEditablePerJobInstructionsToLlm = () =>
  post<{ instructions: EditablePerJobInstructionsToLlm[] }>({ action: "list_editable_per_job_instructions_to_llm" });

export const saveEditablePerJobInstructionsToLlm = (call: LlmJob, text: string) =>
  post<{ saved: EditablePerJobInstructionsToLlm }>({
    action: "save_editable_per_job_instructions_to_llm",
    llm_job: call,
    system_prompt_text: text,
  });

/** Read back by every later solve of this problem, from wherever it is fired. */
export const setEditablePerProblemInstructionsToLlm = (problemId: number, text: string) =>
  post<{ ok: true }>({
    action: "set_editable_per_problem_instructions_to_llm",
    id: problemId,
    editable_per_problem_instructions_to_llm: text,
  });

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
  // Never compulsory: null is "did not say", not "average".
  workingSpeed: "slow" | "mid" | "fast" | null,
) =>
  post<{ ok: true }>({
    action: "record_problem_worked",
    run_id: runId,
    id: ordinal,
    self_reported_working_speed: workingSpeed ?? "",
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

/**
 * Grading is per maneuver; the attempt's outcome comes back as a rollup, and
 * the marks it was rolled up from come back with it. Both are needed because a
 * mark on one row can move others, so the page repaints from the answer rather
 * than from what it assumed the click would do.
 */
export const markManeuverCredit = (attemptId: number, maneuverId: number, gotIt: boolean) =>
  post<{ outcome: AttemptOutcome | null; marks: PerManeuverCreditMark[] }>({
    action: "mark_maneuver_credit",
    attempt_id: attemptId,
    maneuver_id: maneuverId,
    got_it: gotIt,
  });

export const clearManeuverCredit = (attemptId: number, maneuverId: number) =>
  post<{ outcome: AttemptOutcome | null; marks: PerManeuverCreditMark[] }>({
    action: "clear_maneuver_credit",
    attempt_id: attemptId,
    maneuver_id: maneuverId,
  });

export const skipAttempt = (attemptId: number) =>
  post<{ outcome: AttemptOutcome }>({ action: "skip_attempt", attempt_id: attemptId });

/** Prose, typed at the answers page and saved on its own rhythm. */
export const setWhyThisOneWentWrong = (attemptId: number, why: string) =>
  post<{ ok: true }>({
    action: "set_why_this_one_went_wrong",
    attempt_id: attemptId,
    why_this_one_went_wrong: why,
  });

export const markForFurtherPractice = (attemptId: number, marked: boolean) =>
  post<{ ok: true }>({
    action: "mark_for_further_practice",
    attempt_id: attemptId,
    marked,
  });
