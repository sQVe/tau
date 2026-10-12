export interface CutDetail {
  // Absent for output Pi adds besides the script's text items.
  number?: number | undefined;
  name?: string | undefined;
  firstLine: string;
}

export interface CutItem extends CutDetail {
  length: number;
}

export interface BudgetChoice {
  kept: number;
  cut: CutItem[];
}

export interface Segment extends CutDetail {
  kind: 'item' | 'console' | 'error' | 'note' | 'label';
  text: string;
  // What Pi put before this text inside its block: a newline, or nothing at the block start.
  separator: string;
}

type TailKind = Exclude<Segment['kind'], 'item'>;

interface Block {
  body: string;
  tails: Segment[];
}

interface Candidate {
  line: number;
  number: number;
  total: number;
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
  const newline = source.indexOf('\n');
  const rest = newline === -1 ? '' : source.slice(newline);

  return `${optionsPrefix} ${JSON.stringify(fields)}${rest}`;
};

const headerLine = /^==> text (\d+)\/(\d+) <==$/;
const consoleOpen = '<console_output>';
const consoleClose = '</console_output>';
const errorOpen = 'Script error:\n';

const noteLine =
  /^Note: models\.generateImages\(\) returned \d+ images? that the script did not show\. Show each image block of result\.output with image\(block\)\.$/;

const imageLabel =
  /^\[Image (?:saved to [\s\S]* \([^)]*\)|\([^)]*\) could not be saved: [\s\S]*)\]$/;

const lineStart = (text: string, marker: string): number => {
  const start = text.lastIndexOf(`\n${marker}`) + 1;

  return start > 0 || text.startsWith(marker) ? start : -1;
};

const secondLine = (text: string): string => text.split('\n')[1] ?? '';

const makeTail = (kind: TailKind, text: string, start: number): Segment => {
  const tailKinds: Record<TailKind, Pick<Segment, 'name' | 'firstLine'>> = {
    console: { name: 'console output', firstLine: secondLine(text) },
    error: { name: 'script error', firstLine: secondLine(text) },
    note: { name: 'note', firstLine: text },
    label: { name: undefined, firstLine: '' },
  };

  const { name, firstLine } = tailKinds[kind];

  return { kind, text, separator: start > 0 ? '\n' : '', name, firstLine };
};

const takeSuffix = (block: Block, kind: TailKind, start: number): void => {
  block.tails.unshift(makeTail(kind, block.body.slice(start), start));
  block.body = block.body.slice(0, Math.max(start - 1, 0));
};

const isImage = (blocks: readonly (string | undefined)[], index: number): boolean =>
  index < blocks.length && blocks[index] === undefined;

const peelNote = (block: Block): void => {
  const start = lineStart(block.body, 'Note: ');

  if (start !== -1 && noteLine.test(block.body.slice(start))) {
    takeSuffix(block, 'note', start);
  }
};

const peelError = (block: Block): void => {
  const start = lineStart(block.body, errorOpen);

  if (start !== -1) {
    takeSuffix(block, 'error', start);
  }
};

const peelConsole = (block: Block): void => {
  const start = lineStart(block.body, `${consoleOpen}\n`);

  if (start !== -1 && block.body.endsWith(consoleClose)) {
    takeSuffix(block, 'console', start);
  }
};

const peelLabel = (block: Block): void => {
  const start = lineStart(block.body, '[Image ');

  if (start !== -1 && imageLabel.test(block.body.slice(start))) {
    takeSuffix(block, 'label', start);
  }
};

// Pi puts an image's label at the end of the text before it. After the script's items it appends
// the console block, the script error, and a note about unshown images, all in the last text. A
// tail is taken only when it has exactly the shape Pi writes.
const peelBlock = (
  text: string,
  followedByImage: boolean,
  tailExpected: { isLast: boolean; hasError: boolean },
): Block => {
  const block: Block = { body: text, tails: [] };

  if (tailExpected.isLast) {
    peelNote(block);

    if (tailExpected.hasError) {
      peelError(block);
    }

    peelConsole(block);
  }

  if (followedByImage) {
    peelLabel(block);
  }

  return block;
};

const findCandidates = (lines: readonly string[]): Candidate[] =>
  lines.flatMap((line, index) => {
    const match = headerLine.exec(line);

    return match === null
      ? []
      : [{ line: index, number: Number(match[1]), total: Number(match[2]) }];
  });

const formsExactSequence = (candidates: readonly Candidate[][]): boolean => {
  const flat = candidates.flat();
  const total = flat[0]?.total ?? 0;
  const startsEachBody = candidates.every((found) => found[0]?.line === 0);

  const isCounted = flat.every(
    (found, index) => found.number === index + 1 && found.total === total,
  );

  const isComplete = total > 1 && flat.length === total;

  return isComplete && startsEachBody && isCounted;
};

const splitAtCandidates = (lines: readonly string[], found: readonly Candidate[]): string[] =>
  found.map((candidate, index) => {
    const end = found[index + 1]?.line ?? lines.length;

    return lines.slice(candidate.line, end).join('\n');
  });

const makeItem = (part: string, partIndex: number, number: number, counted: boolean): Segment => {
  const contentLines = part.split('\n');
  const stripped = counted && headerLine.test(contentLines[0] ?? '');
  const firstLine = (stripped ? contentLines[1] : contentLines[0]) ?? '';

  return { kind: 'item', text: part, separator: partIndex === 0 ? '' : '\n', number, firstLine };
};

// Pi joins the script's text items into one text per run between images, each item after a
// `==> text k/M <==` line. Script text can print such a line too, so the text is split only when
// the lines of the whole output count exactly 1/M to M/M, with each text starting on one. Any
// other output stays one item per text. Each segment records the separator Pi put before it, so
// joining kept segments rebuilds Pi's text.
export const splitOutput = (
  blocks: readonly (string | undefined)[],
  hasError = false,
): Segment[][] => {
  const peeled = blocks.map((text, index) =>
    text === undefined
      ? undefined
      : peelBlock(text, isImage(blocks, index + 1), {
          isLast: index === blocks.length - 1,
          hasError,
        }),
  );

  const bodies = peeled.map((block) =>
    block === undefined || block.body === '' ? undefined : block.body.split('\n'),
  );

  const candidates = bodies.flatMap((lines) =>
    lines === undefined ? [] : [findCandidates(lines)],
  );

  const counted = formsExactSequence(candidates);
  let number = 0;

  return peeled.map((block, index) => {
    const lines = bodies[index];

    if (block === undefined) {
      return [];
    }

    const found = counted && lines !== undefined ? findCandidates(lines) : [];
    const parts = counted && lines !== undefined ? splitAtCandidates(lines, found) : [block.body];

    const items =
      lines === undefined
        ? []
        : parts.map((part, partIndex) => {
            number += 1;

            return makeItem(part, partIndex, number, counted);
          });

    return items.concat(block.tails);
  });
};

// Pi joins text items with a newline when it counts characters. A budget below the gap reserve
// counts as the reserve, so the list of cut items never outgrows the output it replaces.
export const cutOverBudget = (
  texts: readonly string[],
  tokens: number,
  details: readonly CutDetail[] = texts.map((text, index) => ({
    number: index + 1,
    firstLine: text.split('\n')[0] ?? '',
  })),
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
    number: details[kept + index]?.number,
    name: details[kept + index]?.name,
    firstLine: (details[kept + index]?.firstLine ?? '').slice(0, firstLineLength),
    length: text.length,
  }));

  return { kept, cut };
};

export const describeCutItems = (cut: readonly CutItem[], path: string | undefined): string => {
  const named = cut.slice(0, namedCutItems);
  const rest = cut.slice(namedCutItems);

  const lines = named.map((item) => {
    const name = item.name ?? `item ${item.number}`;

    return `- ${name}: "${item.firstLine}" (${item.length} characters)`;
  });

  const saved = path === undefined ? 'The full output could not be saved.' : `Full output: ${path}`;

  if (rest.length > 0) {
    const numbers = rest.flatMap((item) => (item.number === undefined ? [] : [item.number]));
    const range = numbers.length === 0 ? '' : `items ${numbers[0]}-${numbers.at(-1)}: `;
    const characters = rest.reduce((sum, item) => sum + item.length, 0);

    lines.push(`- ${range}${rest.length} more items, ${characters} characters`);
  }

  return `[Output over the budget. Cut ${cut.length} text item${cut.length === 1 ? '' : 's'}:\n${lines.join('\n')}\n${saved}]`;
};
