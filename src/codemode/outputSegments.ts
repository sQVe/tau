export interface CutDetail {
  // Absent for output Pi adds besides the script's text items.
  number?: number | undefined;
  name?: string | undefined;
  firstLine: string;
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
