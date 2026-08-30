import type {
  AnswerRow,
  MathPracticeProblem,
  SelfGrade,
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
  problems: MathPracticeProblem[];
}

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
