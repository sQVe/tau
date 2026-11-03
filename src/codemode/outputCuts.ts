import type { CutDetail, Segment } from './outputSegments.js';

export interface CutItem extends CutDetail {
  length: number;
}

export interface BudgetChoice {
  kept: number;
  cut: CutItem[];
}

const charactersPerToken = 4;
const firstLineLength = 100;
const namedCutItems = 10;
const gapReserve = 2500;

// Pi joins text items with a newline when it counts characters. A budget below the gap reserve
// counts as the reserve, so the list of cut items never outgrows the output it replaces.
export const cutOverBudget = (
  segments: readonly Segment[],
  tokens: number,
): BudgetChoice | undefined => {
  const budget = Math.max(tokens * charactersPerToken, gapReserve);

  const total =
    segments.reduce((sum, segment) => sum + segment.text.length, 0) +
    Math.max(segments.length - 1, 0);

  if (total <= budget) {
    return undefined;
  }

  const keepBudget = Math.max(budget - gapReserve, 0);
  let used = 0;
  let kept = 0;

  for (const segment of segments) {
    const next = used + segment.text.length + (kept > 0 ? 1 : 0);

    if (next > keepBudget) {
      break;
    }

    used = next;
    kept += 1;
  }

  const cut = segments.slice(kept).map((segment) => ({
    number: segment.number,
    name: segment.name,
    firstLine: segment.firstLine.slice(0, firstLineLength),
    length: segment.text.length,
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
