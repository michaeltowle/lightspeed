export interface TmpnameProblem01 {
  id: number;
  ordinal: number;
  problem_html: string;
}

export interface TmpnameAnswerRow01 {
  attempt_id: number;
  ordinal: number;
  problem_html: string;
  answer_html: string;
  elapsed_ms: number;
  self_grade: TmpnameSelfGrade01 | null;
}

export type TmpnameSelfGrade01 = "right" | "wrong" | "skipped";

export interface TmpnameTrophy01 {
  id: number;
  created_at: string;
  self_grade: TmpnameSelfGrade01 | null;
}

export interface UnsavedImageAttachment {
  dataUrl: string;
  base64: string;
  mimeType: string;
  w: number;
  h: number;
  byteSize: number;
}

export type TmpnameView01 =
  | { name: "compose" }
  | {
      name: "problem";
      runId: number;
      problems: TmpnameProblem01[];
      index: number;
    }
  | { name: "answers"; runId: number };
