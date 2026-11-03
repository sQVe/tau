interface Options {
  fields: Record<string, unknown>;
}

export const defaultOutputTokens = 4000;

const optionsPrefix = '// @options:';
const budgetPrefix = '// @budget:';
const raisedOutputTokens = 100_000_000;

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
  const newline = source.indexOf('\n');
  const rest = newline === -1 ? '' : source.slice(newline);

  return `${optionsPrefix} ${JSON.stringify(fields)}${rest}`;
};
