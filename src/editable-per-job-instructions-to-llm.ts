/**
 * The words each LLM job is given, as Mike last saved them.
 *
 * Code owns the shape of what comes back; these own everything the model is
 * told. The model functions take the text as an argument and add nothing to it
 * but the material of the one call -- a screenshot, a request, a statement --
 * so what the editor shows is the whole of the system prompt.
 */
export const LLM_JOBS = [
  "transcribe_from_screenshot",
  "build_to_order_from_prompt",
  "solve_step_by_step",
] as const;
export type LlmJob = (typeof LLM_JOBS)[number];

export const isLlmJob = (value: unknown): value is LlmJob =>
  LLM_JOBS.includes(value as LlmJob);

export interface EditablePerJobInstructionsToLlm {
  llm_job: LlmJob;
  system_prompt_text: string;
  created_at: string;
}

/** The revision in force for every job: the latest saved. */
export async function editablePerJobInstructionsToLlmInForce(
  db: D1Database,
): Promise<EditablePerJobInstructionsToLlm[]> {
  const { results } = await db
    .prepare(
      `SELECT r.llm_job, r.system_prompt_text, r.created_at
         FROM editable_per_job_instructions_to_llm r
        WHERE r.id = (SELECT MAX(id) FROM editable_per_job_instructions_to_llm
                       WHERE llm_job = r.llm_job)`,
    )
    .all<EditablePerJobInstructionsToLlm>();
  return results.filter((row) => isLlmJob(row.llm_job));
}

/**
 * The text one job goes out with. No fallback in code: a second copy here
 * would be a second place the words live, and the one nobody can see.
 */
export async function systemPromptTextFor(
  db: D1Database,
  job: LlmJob,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT system_prompt_text FROM editable_per_job_instructions_to_llm
        WHERE llm_job = ? ORDER BY id DESC LIMIT 1`,
    )
    .bind(job)
    .first<{ system_prompt_text: string }>();
  if (!row) throw new Error(`no instructions saved for ${job}`);
  return row.system_prompt_text;
}

/**
 * Save a new revision. One that says exactly what is already in force is not
 * written, so pressing save twice leaves one row and not a history of nothing.
 */
export async function saveEditablePerJobInstructionsToLlm(
  db: D1Database,
  job: LlmJob,
  text: string,
): Promise<EditablePerJobInstructionsToLlm> {
  await db
    .prepare(
      `INSERT INTO editable_per_job_instructions_to_llm (llm_job, system_prompt_text)
       SELECT ?1, ?2
        WHERE ?2 IS NOT (SELECT system_prompt_text FROM editable_per_job_instructions_to_llm
                          WHERE llm_job = ?1 ORDER BY id DESC LIMIT 1)`,
    )
    .bind(job, text)
    .run();
  const row = await db
    .prepare(
      `SELECT llm_job, system_prompt_text, created_at
         FROM editable_per_job_instructions_to_llm
        WHERE llm_job = ? ORDER BY id DESC LIMIT 1`,
    )
    .bind(job)
    .first<EditablePerJobInstructionsToLlm>();
  return row!;
}
