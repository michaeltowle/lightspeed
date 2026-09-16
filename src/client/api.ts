import type {
  AnswerRow,
  MathPracticeProblem,
  NamedProblemGenerator,
  SelfGrade,
  StudyContextTag,
  Trophy,
  UnsavedImageAttachment,
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

export interface GeneratedProblemSet {
  set_id: number;
  run_id: number;
  // What was asked for, which is not always what arrived: a set cut short by
  // the token cap opens with the problems that finished.
  requested_count: number;
  problems: MathPracticeProblem[];
}

/** A prompt typed fresh: generates, and becomes a generator on the way through. */
export const generateProblems = (
  prompt: string,
  attachments: UnsavedImageAttachment[],
  requestedCount: number,
) =>
  post<GeneratedProblemSet>({
    action: "generate_problems",
    prompt,
    requested_count: requestedCount,
    unsaved_image_attachments: attachments.map((a) => ({
      base64: a.base64,
      mimeType: a.mimeType,
      w: a.w,
      h: a.h,
      byteSize: a.byteSize,
    })),
  });

/** More of a type already named. Same verb, entered by id instead of by text. */
export const practiceNamedProblemGenerator = (
  namedProblemGeneratorId: number,
  requestedCount: number,
) =>
  post<GeneratedProblemSet>({
    action: "generate_problems",
    named_problem_generator_id: namedProblemGeneratorId,
    requested_count: requestedCount,
  });

export const listNamedProblemGenerators = () =>
  post<{ generators: NamedProblemGenerator[]; study_context_tags: StudyContextTag[] }>({
    action: "list_named_problem_generators",
  });

/**
 * Replace a generator's tags with the set given. Names, not ids: one that has
 * never been used before is created on the way through, and one left wearing
 * nothing is retired. Returns the catalogue as it stands afterwards.
 */
export const retagNamedProblemGenerator = (id: number, names: string[]) =>
  post<{ study_context_tags: StudyContextTag[]; study_context_tag_ids: number[] }>({
    action: "retag_named_problem_generator",
    id,
    study_context_tag_names: names,
  });

export const renameNamedProblemGenerator = (id: number, name: string) =>
  post<{ ok: true; name: string }>({
    action: "rename_named_problem_generator",
    id,
    name,
  });

export const reviseNamedProblemGeneratorPrompt = (id: number, promptText: string) =>
  post<{ ok: true }>({
    action: "revise_named_problem_generator_prompt",
    id,
    prompt_text: promptText,
  });

/** Both directions, the way a mark is set and cleared. */
export const archiveNamedProblemGenerator = (id: number, archived: boolean) =>
  post<{ ok: true }>({
    action: "archive_named_problem_generator",
    id,
    archived,
  });

export const suggestNamedProblemGeneratorName = (promptText: string) =>
  post<{ name: string }>({
    action: "suggest_named_problem_generator_name",
    prompt_text: promptText,
  });

export const recordAttempt = (
  problemId: number,
  runId: number,
  elapsedMs: number,
  skipped = false,
) =>
  post<{ attempt_id: number }>({
    action: "record_attempt",
    problem_id: problemId,
    run_id: runId,
    elapsed_ms: elapsedMs,
    // A skip pre-fills self_grade; anything else is left NULL to be graded on
    // the answer page. The problem view no longer skips, but the worker still
    // honours the flag.
    skipped,
  });

export const revealAnswers = (runId: number) =>
  post<{ rows: AnswerRow[] }>({
    action: "reveal_answers",
    run_id: runId,
  });

export const gradeAttempt = (
  attemptId: number,
  selfGrade: SelfGrade,
) =>
  post<{ ok: true }>({
    action: "grade_attempt",
    attempt_id: attemptId,
    self_grade: selfGrade,
  });

export const markForFurtherPractice = (attemptId: number, marked: boolean) =>
  post<{ ok: true }>({
    action: "mark_for_further_practice",
    attempt_id: attemptId,
    marked,
  });

/** Opens a new set on the same prompt, weighted toward this run's marks. */
export const furtherPractice = (runId: number) =>
  post<GeneratedProblemSet>({ action: "further_practice", run_id: runId });

export const trophyWall = () =>
  post<{ attempts: Trophy[] }>({ action: "trophy_wall" });
