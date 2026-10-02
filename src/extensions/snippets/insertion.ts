export interface EditorText {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

/** The `#query` on `line`, from the `#` at `start` to the cursor at `end`. */
export interface QueryRange {
  line: number;
  start: number;
  end: number;
}

const isBlank = (text: string) => text.trim() === '';

/**
 * Replaces the query with the body lines. Text before the query on its line
 * stays above the body, and text after the cursor goes below it, each split
 * off by a blank line. The cursor ends after the body.
 */
export const insertSnippetBody = (lines: string[], query: QueryRange, body: string): EditorText => {
  const line = lines[query.line] ?? '';
  const before = line.slice(0, query.start);
  const after = line.slice(query.end);
  const bodyLines = body.split('\n');
  const inserted: string[] = [];

  if (!isBlank(before)) {
    inserted.push(before.trimEnd(), '');
  }

  inserted.push(...bodyLines);

  const cursorLine = query.line + inserted.length - 1;

  if (!isBlank(after)) {
    inserted.push('', after.trimStart());
  }

  return {
    lines: [...lines.slice(0, query.line), ...inserted, ...lines.slice(query.line + 1)],
    cursorLine,
    cursorCol: bodyLines.at(-1)?.length ?? 0,
  };
};
