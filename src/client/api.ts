import type {
  TmpnameAnswerRow01,
  TmpnameProblem01,
  TmpnameSelfGrade01,
  TmpnameTrophy01,
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

export interface TmpnameGeneratedSet01 {
  set_id: number;
  run_id: number;
  problems: TmpnameProblem01[];
}

export const tmpnameGenerateProblems01 = (
  prompt: string,
  attachments: UnsavedImageAttachment[],
  requestedCount: number,
) =>
  post<TmpnameGeneratedSet01>({
    action: "tmpname_generate_problems_01",
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

export const tmpnameReplaySet01 = (setId: number) =>
  post<TmpnameGeneratedSet01>({
    action: "tmpname_replay_set_01",
    set_id: setId,
  });

export const tmpnameRecordAttempt01 = (
  problemId: number,
  runId: number,
  elapsedMs: number,
  skipped = false,
) =>
  post<{ attempt_id: number }>({
    action: "tmpname_record_attempt_01",
    problem_id: problemId,
    run_id: runId,
    elapsed_ms: elapsedMs,
    // A skip pre-fills self_grade; anything else is left NULL to be graded on
    // the answer page. The problem view no longer skips, but the worker still
    // honours the flag.
    skipped,
  });

export const tmpnameRevealAnswers01 = (runId: number) =>
  post<{ rows: TmpnameAnswerRow01[] }>({
    action: "tmpname_reveal_answers_01",
    run_id: runId,
  });

export const tmpnameGradeAttempt01 = (
  attemptId: number,
  selfGrade: TmpnameSelfGrade01,
) =>
  post<{ ok: true }>({
    action: "tmpname_grade_attempt_01",
    attempt_id: attemptId,
    self_grade: selfGrade,
  });

export const tmpnameTrophyWall01 = () =>
  post<{ attempts: TmpnameTrophy01[] }>({ action: "tmpname_trophy_wall_01" });
