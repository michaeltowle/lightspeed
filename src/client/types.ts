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
}

export type SelfGrade = "right" | "wrong" | "skipped";

export interface Trophy {
  id: number;
  created_at: string;
  self_grade: SelfGrade | null;
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
  | { name: "compose" }
  | {
      name: "problem";
      runId: number;
      problems: MathPracticeProblem[];
      index: number;
    }
  | { name: "answers"; runId: number };
