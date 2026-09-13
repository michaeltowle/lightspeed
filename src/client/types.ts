export interface MathPracticeProblem {
  id: number;
  ordinal: number;
  problem_html: string;
}

export interface AnswerRow {
  attempt_id: number;
  ordinal: number;
  problem_html: string;
  final_answer_html: string;
  solution_walkthrough_html: string;
  elapsed_ms: number;
  self_grade: SelfGrade | null;
  // SQLite has no boolean; this is 0 or 1.
  marked_for_further_practice: number;
}

export type SelfGrade = "right" | "wrong" | "skipped";

export interface Trophy {
  id: number;
  created_at: string;
  // Never null and never "skipped": the wall is fed answered attempts only.
  self_grade: Exclude<SelfGrade, "skipped">;
  // Which practice type earned it. The wall ignores this; the dashboard buckets
  // on it, which is why no generator card needs a query of its own.
  named_problem_generator_id: number;
}

/** A named, standing prompt: one practice type, worked as often as it is useful. */
export interface NamedProblemGenerator {
  id: number;
  name: string;
  prompt_text: string;
  requested_count: number;
  // An ISO timestamp parks it in the drawer; null puts it on the dashboard.
  archived_at: string | null;
  created_at: string;
  attachment_count: number;
}

export interface UnsavedImageAttachment {
  dataUrl: string;
  base64: string;
  mimeType: string;
  w: number;
  h: number;
  byteSize: number;
}

export type View =
  | { name: "generators" }
  | {
      name: "problem";
      runId: number;
      requestedCount: number;
      problems: MathPracticeProblem[];
      index: number;
    }
  | { name: "answers"; runId: number };
