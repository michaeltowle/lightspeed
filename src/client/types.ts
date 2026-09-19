/** How a problem came to exist. Origin is a column, never a parent. */
export type HowThisProblemCameToBe =
  | "transcribed_from_a_screenshot_of_record"
  | "built_to_order_from_a_prompt"
  | "modelled_on_another_problem"
  | "isolated_from_one_maneuver";

/** How a problem is served when nothing at launch says otherwise. */
export type DefaultServiceStyle = "exact" | "variant";

/** 'partial' is what a mixed set of maneuver marks rolls up to, never a button. */
export type AttemptOutcome = "right" | "partial" | "wrong" | "skipped";

/** The atom. The only thing that can be selected, served, attempted or filed. */
export interface MathPracticeProblem {
  id: number;
  name: string;
  // The number off the page -- "2.1(a)". Null when nothing numbered it.
  textbook_problem_number_label: string | null;
  // Self-contained: a multi-part screenshot's stem is folded into each part.
  statement_html: string;
  how_this_problem_came_to_be: HowThisProblemCameToBe;
  parent_problem_varied_from: number | null;
  the_maneuver_it_was_isolated_from: number | null;
  text_that_minted_this_problem: string;
  default_service_style: DefaultServiceStyle;
  // Null until the maneuver table lands. A problem is servable before then;
  // it simply has no answer to reveal yet.
  broken_into_maneuvers_at: string | null;
  created_at: string;
  archived_at: string | null;
  study_context_tag_ids: number[];
  screenshot_of_record_ids: number[];
  maneuver_count: number;
}

/** One row of a problem's table. The last one is the answer. */
export interface Maneuver {
  id: number;
  math_practice_problem_id: number;
  ordinal: number;
  name: string;
  // Plain English, no mathematics -- which is what lets it be shown as help.
  method_text: string;
  result_html: string;
}

export interface PerManeuverCreditMark {
  problem_attempt_id: number;
  maneuver_id: number;
  // SQLite has no boolean; this is 0 or 1.
  got_it: number;
}

export interface AnswerRow {
  attempt_id: number;
  ordinal: number;
  elapsed_ms: number | null;
  outcome: AttemptOutcome | null;
  needed_help_during_attempt: number;
  marked_for_further_practice: number;
  problem_id: number;
  name: string;
  textbook_problem_number_label: string | null;
  statement_html: string;
  broken_into_maneuvers_at: string | null;
}

/** What a run serves: statements only, with no table attached. */
export interface ServedProblem {
  id: number;
  name: string;
  textbook_problem_number_label: string | null;
  statement_html: string;
  broken_into_maneuvers_at: string | null;
}

export interface Trophy {
  id: number;
  created_at: string;
  // Never null and never "skipped": the wall is fed answered attempts only.
  outcome: Exclude<AttemptOutcome, "skipped">;
  // Which problem earned it. The wall ignores this; the bank buckets on it,
  // which is why no row needs a query of its own.
  math_practice_problem_id: number;
}


export const STUDY_CONTEXT_TAG_FIELDS = [
  "class",
  // Beside class rather than at the end: the two together are what an
  // assignment is filed under, and the order drives the chip palette offset.
  "assignment",
  "source",
  "target",
  "status",
] as const;

export type StudyContextTagField = (typeof STUDY_CONTEXT_TAG_FIELDS)[number];

/** Where a problem sits in the study. Unique by name within its field. */
export interface StudyContextTag {
  id: number;
  field: StudyContextTagField;
  name: string;
  // Index into the worker's palette, fixed when the tag is created.
  chip_color_ordinal: number;
}

export interface UnsavedScreenshot {
  dataUrl: string;
  base64: string;
  mimeType: string;
  w: number;
  h: number;
  byteSize: number;
}

export type View =
  | { name: "bank" }
  | {
      name: "problem";
      runId: number;
      problems: ServedProblem[];
      index: number;
    }
  | { name: "answers"; runId: number };
