/** How a problem came to exist. Origin is a column, never a parent. */
export type HowThisProblemCameToBe =
  | "transcribed_from_a_screenshot_of_record"
  | "built_to_order_from_a_prompt"
  | "modelled_on_another_problem";

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
  text_that_minted_this_problem: string;
  // How this one problem should be solved, in Mike's words. Goes out with it
  // every time it is solved. Empty when nothing has been said.
  editable_per_problem_instructions_to_llm: string;
  default_service_style: DefaultServiceStyle;
  // Null until the maneuver table lands. A problem is servable before then;
  // it simply has no answer to reveal yet.
  last_solved_by_llm_at: string | null;
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
  // Shown as help with the results covered, so the instructions keep it from
  // giving the answer away. Rendered like a result, in case they allow maths.
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
  // The credit earned, as a fraction in two pieces. Both null until graded.
  count_of_maneuvers_got: number | null;
  count_of_maneuvers_faced: number | null;
  why_this_one_went_wrong: string;
  needed_help_during_attempt: number;
  marked_for_further_practice: number;
  problem_id: number;
  name: string;
  textbook_problem_number_label: string | null;
  statement_html: string;
  last_solved_by_llm_at: string | null;
  editable_per_problem_instructions_to_llm: string;
}

/** What a run serves: statements only, with no table attached. */
export interface ServedProblem {
  id: number;
  // The attempt written when the run opened. Carried so a problem can be
  // skipped from the page it is worked on.
  problem_attempt_id: number | null;
  name: string;
  textbook_problem_number_label: string | null;
  statement_html: string;
  last_solved_by_llm_at: string | null;
}

export interface Trophy {
  id: number;
  created_at: string;
  // Never null and never "skipped": the wall is fed answered attempts only.
  outcome: Exclude<AttemptOutcome, "skipped">;
  // The bank's columns are all read off this one payload bucketed by problem,
  // which is why an attempt carries rather more than a square needs.
  count_of_maneuvers_got: number | null;
  count_of_maneuvers_faced: number | null;
  needed_help_during_attempt: number;
  // Said before moving on, and never compulsory, so usually null.
  self_reported_working_speed: "slow" | "mid" | "fast" | null;
  why_this_one_went_wrong: string;
  // Which problem earned it. The wall ignores this; the bank buckets on it,
  // which is why no row needs a query of its own.
  math_practice_problem_id: number;
}


// The columns a problem is filed under. Fixed for now, and short on purpose:
// a field earns its place by a use-case asking for it. `source`, `target` and
// `status` were here before anything needed them and carried no rows, so they
// are gone from the schema's point of view too -- the CHECK still admits them,
// which costs nothing and leaves the door open.
export const STUDY_CONTEXT_TAG_FIELDS = ["class", "assignment"] as const;

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

/** The model calls whose words Mike edits. Named after the actions that make them. */
export type LlmJob =
  | "transcribe_from_screenshot"
  | "build_to_order_from_prompt"
  | "solve_step_by_step";

/** The revision in force for one call. */
export interface EditablePerJobInstructionsToLlm {
  llm_job: LlmJob;
  system_prompt_text: string;
  created_at: string;
}
