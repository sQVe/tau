export interface CutItem {
  number: number;
  firstLine: string;
  length: number;
}

export interface BudgetChoice {
  kept: number;
  cut: CutItem[];
}

interface Options {
  fields: Record<string, unknown>;
}

export const defaultOutputTokens = 4000;

const optionsPrefix = '// @options:';
const budgetPrefix = '// @budget:';
const raisedOutputTokens = 100_000_000;
const charactersPerToken = 4;
const firstLineLength = 100;
const namedCutItems = 10;
const gapReserve = 2500;

const parseOptionsLine = (line: string): Options | undefined => {
  const trimmed = line.trimStart();

  if (!trimmed.startsWith(optionsPrefix)) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(trimmed.slice(optionsPrefix.length));

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }

    return { fields: { ...value } };
  } catch {
    return undefined;
  }
};

const splitLines = (source: string): string[] =>
  source.split('\n').map((line) => line.replace(/\r$/, ''));

const declaredTokens = (source: string): number | undefined => {
  const [firstLine = ''] = splitLines(source);
  const tokens = parseOptionsLine(firstLine)?.fields.max_output_tokens;

  return typeof tokens === 'number' && Number.isSafeInteger(tokens) ? tokens : undefined;
};

export const readOutputBudget = (source: string): number =>
  declaredTokens(source) ?? defaultOutputTokens;

const hasReason = (source: string): boolean => {
  const second = splitLines(source)[1]?.trimStart() ?? '';

  return second.startsWith(budgetPrefix) && second.slice(budgetPrefix.length).trim().length > 0;
};

export const decideBudgetRefusal = (source: string): string | undefined => {
  const tokens = declaredTokens(source);
  const raisesBudget = tokens !== undefined && tokens > defaultOutputTokens;

  if (!raisesBudget || hasReason(source)) {
    return undefined;
  }

  return `A codemode script has an output budget of ${defaultOutputTokens} tokens. This script sets max_output_tokens to ${tokens}. To raise the budget, add a second line with the reason: \`${budgetPrefix} <reason>\`. Otherwise lower max_output_tokens to ${defaultOutputTokens} or less, or print less.`;
};

const isNonNegativeSafeInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const acceptsOutputTokens = (value: unknown): boolean =>
  value === undefined || isNonNegativeSafeInteger(value);

// Pi cuts the middle of an over-budget result without naming it. Raising Pi's cap lets Tau cut by
// whole items and name them.
export const raiseOutputCap = (source: string): string => {
  const [firstLine = ''] = splitLines(source);
  const options = parseOptionsLine(firstLine);

  if (options !== undefined && !acceptsOutputTokens(options.fields.max_output_tokens)) {
    return source;
  }

  if (options === undefined) {
    return firstLine.trimStart().startsWith(optionsPrefix)
      ? source
      : `${optionsPrefix} ${JSON.stringify({ max_output_tokens: raisedOutputTokens })}\n${source}`;
  }

  const fields = { ...options.fields, max_output_tokens: raisedOutputTokens };
  const rest = source.slice(source.indexOf('\n'));

  return `${optionsPrefix} ${JSON.stringify(fields)}${rest}`;
};

// Pi joins text items with a newline when it counts characters. A budget below the gap reserve
// counts as the reserve, so the list of cut items never outgrows the output it replaces.
export const cutOverBudget = (
  texts: readonly string[],
  tokens: number,
): BudgetChoice | undefined => {
  const budget = Math.max(tokens * charactersPerToken, gapReserve);
  const total = texts.reduce((sum, text) => sum + text.length, 0) + Math.max(texts.length - 1, 0);

  if (total <= budget) {
    return undefined;
  }

  const keepBudget = Math.max(budget - gapReserve, 0);
  let used = 0;
  let kept = 0;

  for (const text of texts) {
    const next = used + text.length + (kept > 0 ? 1 : 0);

    if (next > keepBudget) {
      break;
    }

    used = next;
    kept += 1;
  }

  const cut = texts.slice(kept).map((text, index) => ({
    number: kept + index + 1,
    firstLine: (text.split('\n')[0] ?? '').slice(0, firstLineLength),
    length: text.length,
  }));

  return { kept, cut };
};

export const describeCutItems = (cut: readonly CutItem[], path: string | undefined): string => {
  const named = cut.slice(0, namedCutItems);
  const rest = cut.slice(namedCutItems);

  const lines = named.map(
    (item) => `- item ${item.number}: "${item.firstLine}" (${item.length} characters)`,
  );

  const saved = path === undefined ? 'The full output could not be saved.' : `Full output: ${path}`;

  if (rest.length > 0) {
    const first = rest[0]?.number;
    const last = rest.at(-1)?.number;
    const characters = rest.reduce((sum, item) => sum + item.length, 0);

    lines.push(`- items ${first}-${last}: ${rest.length} more items, ${characters} characters`);
  }

  return `[Output over the budget. Cut ${cut.length} text item${cut.length === 1 ? '' : 's'}:\n${lines.join('\n')}\n${saved}]`;
};
