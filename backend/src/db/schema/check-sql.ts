/**
 * Builders for the SQL text of `check` constraints (M5-T7). Pure strings, so they are unit
 * tested and the generated migration stays readable. Column names are the snake_case SQL names;
 * values come from code constants only (never user input), quoted as SQL literals.
 */

/** `'A', 'B'` (single quotes doubled, so a constant can never break out of the literal). */
export function quoted(values: readonly string[]): string {
  if (values.length === 0) throw new Error('quoted() needs at least one value');
  return values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ');
}

/** `column in (…)`, or `column is null or column in (…)`. */
export function inListSql(
  column: string,
  values: readonly string[],
  nullable = false,
): string {
  const list = `${column} in (${quoted(values)})`;
  return nullable ? `${column} is null or ${list}` : list;
}

/** `char_length(column) between min and max` (+ `column is null or` when nullable). */
export function lengthSql(
  column: string,
  min: number,
  max: number,
  nullable = false,
): string {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min)
    throw new Error('lengthSql() needs integers 0 ≤ min ≤ max');
  const range = `char_length(${column}) between ${min} and ${max}`;
  return nullable ? `${column} is null or ${range}` : range;
}

/** `column ~ 'pattern'` (+ `column is null or` when nullable). */
export function patternSql(
  column: string,
  pattern: string,
  nullable = false,
): string {
  const match = `${column} ~ '${pattern.replaceAll("'", "''")}'`;
  return nullable ? `${column} is null or ${match}` : match;
}

/** `a >= 0 and b >= 0 and …` (counter columns). */
export function nonNegativeSql(columns: readonly string[]): string {
  if (columns.length === 0) throw new Error('nonNegativeSql() needs columns');
  return columns.map((c) => `${c} >= 0`).join(' and ');
}

/**
 * All-or-nothing group: either every column is null or none is
 * (`(a is null and b is null) or (a is not null and b is not null)`).
 */
export function allOrNoneSql(columns: readonly string[]): string {
  if (columns.length < 2) throw new Error('allOrNoneSql() needs 2+ columns');
  const all = (test: string) =>
    columns.map((c) => `${c} ${test}`).join(' and ');
  return `(${all('is null')}) or (${all('is not null')})`;
}

/** `camelCase` → `snake_case` (the `casing: 'snake_case'` rule, for check SQL of generated columns). */
export function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
