export const STUDY_CONTEXT_TAG_FIELDS = ["class", "source", "target", "status"] as const;
export type StudyContextTagField = (typeof STUDY_CONTEXT_TAG_FIELDS)[number];

export const isStudyContextTagField = (value: unknown): value is StudyContextTagField =>
  STUDY_CONTEXT_TAG_FIELDS.includes(value as StudyContextTagField);

const MAX_TAG_NAME_LENGTH = 32;
const MAX_TAGS_PER_PROBLEM = 8;

/**
 * Pale ground, saturated text of the same hue -- the shape Microsoft Lists gives
 * a choice pill. Its actual defaults are not published anywhere citable and have
 * changed at least once, so these are built to the same rule rather than copied,
 * and ordered the way Lists runs: cool hues first, warm after, neutral last.
 *
 * A new tag takes the next entry round, so the first ten in a field are all
 * distinguishable before any colour repeats. Dark pairs are the same hues
 * re-seated for a dark ground -- a pale pill on black glares.
 */
export const CHIP_COLOR_PALETTE = [
  { light: ["#E8E6F8", "#4F52B2"], dark: ["#31325C", "#B9BCF0"] },
  { light: ["#DDECF9", "#0F6CBD"], dark: ["#17354F", "#8FC4EE"] },
  { light: ["#D5EFEF", "#0B6B6B"], dark: ["#123C3C", "#86D3D3"] },
  { light: ["#DCF2E3", "#0E7A42"], dark: ["#133A26", "#86D6A6"] },
  { light: ["#FAF0CE", "#7D6206"], dark: ["#40360D", "#E0C868"] },
  { light: ["#FCE6D4", "#A54C08"], dark: ["#4A2C14", "#F0B183"] },
  { light: ["#FBDCD8", "#B3303F"], dark: ["#4C1F22", "#F0A099"] },
  { light: ["#FADAE9", "#A3007F"], dark: ["#47162F", "#EFA3CE"] },
  { light: ["#EEDDF3", "#7A4FA8"], dark: ["#3A2749", "#CBA8E4"] },
  { light: ["#E6E8EB", "#4A5560"], dark: ["#2B3138", "#B6C0C9"] },
];

export const chipColorPaletteCss = [
  ...CHIP_COLOR_PALETTE.map(
    (entry, i) =>
      `  .chip-color-${i} { background: ${entry.light[0]}; color: ${entry.light[1]}; border-color: ${entry.light[0]}; }`,
  ),
  "  @media (prefers-color-scheme: dark) {",
  ...CHIP_COLOR_PALETTE.map(
    (entry, i) =>
      `    .chip-color-${i} { background: ${entry.dark[0]}; color: ${entry.dark[1]}; border-color: ${entry.dark[0]}; }`,
  ),
  "  }",
].join("\n");

/**
 * Trim, squash and de-duplicate a typed tag list.
 *
 * De-duplication is case-insensitive to match the column's NOCASE uniqueness:
 * without it a name typed twice in one list is two rows to insert, and the
 * second collides with the first on the way in.
 */
export function normalizeTagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of raw) {
    const name = String(entry).replace(/\s+/g, " ").trim().slice(0, MAX_TAG_NAME_LENGTH);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
    if (names.length === MAX_TAGS_PER_PROBLEM) break;
  }
  return names;
}

export interface StudyContextTagRow {
  id: number;
  field: StudyContextTagField;
  name: string;
  chip_color_ordinal: number;
}

/** Every tag there is, already grouped by field so the bank need not sort. */
export async function tagCatalogue(db: D1Database): Promise<StudyContextTagRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, field, name, chip_color_ordinal
         FROM study_context_tag ORDER BY field, name`,
    )
    .all<StudyContextTagRow>();
  return results;
}

/**
 * Replace one field's tags on one problem, leaving the other fields alone --
 * editing the source must not silently clear the class.
 *
 * A name this field has not seen before is created here and takes the next
 * colour round. Tags left wearing nothing are NOT retired: the catalogue is
 * worth more than the hygiene, and it outlives the problems filed under it --
 * migration 0010 leaves every tag unworn, so an auto-retire here would wipe the
 * lot on the first edit. Retiring is a deliberate act instead.
 */
export async function setTagsForField(
  db: D1Database,
  problemId: number,
  field: StudyContextTagField,
  names: string[],
): Promise<void> {
  // Each field starts at a different point in the palette, so tags differ from
  // their neighbours down a column and a row of four chips is not four of the
  // same colour.
  const fieldOffset = STUDY_CONTEXT_TAG_FIELDS.indexOf(field) * 3;

  for (const name of names) {
    // The colour is chosen inside the insert rather than read out first, so two
    // tags created together cannot both claim the same count.
    await db
      .prepare(
        `INSERT OR IGNORE INTO study_context_tag (field, name, chip_color_ordinal)
         VALUES (?1, ?2,
                 (?4 + (SELECT COUNT(*) FROM study_context_tag WHERE field = ?1))
                 % ?3)`,
      )
      .bind(field, name, CHIP_COLOR_PALETTE.length, fieldOffset)
      .run();
  }

  await db
    .prepare(
      `DELETE FROM study_context_tag_membership
        WHERE math_practice_problem_id = ?1
          AND study_context_tag_id IN
              (SELECT id FROM study_context_tag WHERE field = ?2)`,
    )
    .bind(problemId, field)
    .run();

  if (names.length) {
    // Bound placeholders, never interpolated names -- the strings are typed by
    // hand and go nowhere near the SQL text.
    const placeholders = names.map(() => "?").join(", ");
    await db
      .prepare(
        `INSERT INTO study_context_tag_membership
           (math_practice_problem_id, study_context_tag_id)
         SELECT ?, id FROM study_context_tag
          WHERE field = ? AND name IN (${placeholders})`,
      )
      .bind(problemId, field, ...names)
      .run();
  }
}

/** Apply every field's tags at once, the way a fresh intake supplies them. */
export async function setAllTagFields(
  db: D1Database,
  problemId: number,
  byField: Record<string, unknown> | undefined,
): Promise<void> {
  if (!byField) return;
  for (const field of STUDY_CONTEXT_TAG_FIELDS) {
    const names = normalizeTagNames(byField[field] ?? []);
    if (names.length) await setTagsForField(db, problemId, field, names);
  }
}

/** Copy every tag from one problem onto another -- how a variant inherits its filing. */
export async function inheritTags(
  db: D1Database,
  fromProblemId: number,
  toProblemId: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO study_context_tag_membership
         (math_practice_problem_id, study_context_tag_id)
       SELECT ?, study_context_tag_id FROM study_context_tag_membership
        WHERE math_practice_problem_id = ?`,
    )
    .bind(toProblemId, fromProblemId)
    .run();
}

/**
 * The mandates that apply to a problem: those scoped to a tag it wears, plus
 * every unscoped one.
 */
export async function mandatesFor(db: D1Database, problemId: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT rule_text FROM professorial_style_mandate m
        WHERE m.archived_at IS NULL
          AND (m.study_context_tag_id IS NULL
               OR m.study_context_tag_id IN
                  (SELECT study_context_tag_id FROM study_context_tag_membership
                    WHERE math_practice_problem_id = ?))
        ORDER BY m.id`,
    )
    .bind(problemId)
    .all<{ rule_text: string }>();
  return results.map((row) => row.rule_text);
}
