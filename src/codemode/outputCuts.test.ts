import { expect, it } from 'vitest';

import { cutOverBudget, describeCutItems } from './outputCuts.js';
import { splitOutput } from './outputSegments.js';
import type { Segment } from './outputSegments.js';

const label = '[Image saved to /tmp/x.png (png)]';
const consoleBlock = '<console_output>\nc line\nmore\n</console_output>';

const itemSegments = (texts: readonly string[]): Segment[] =>
  texts.map((text, index): Segment => ({
    kind: 'item',
    text,
    number: index + 1,
    firstLine: text.split('\n')[0] ?? '',
    separator: '',
  }));

it('chooses no cut for items within the budget', () => {
  expect(cutOverBudget(itemSegments(['a'.repeat(10), 'b'.repeat(10)]), 6)).toBeUndefined();
});

it.for([
  ['an item over the budget', ['a'.repeat(1000), 'b'.repeat(3000), 'c'.repeat(2)], 1000, 1, [2, 3]],
  ['a first item over the budget', ['a'.repeat(5000), 'b'], 1000, 0, [1, 2]],
] as const)('keeps whole items in order for %s', ([, texts, tokens, kept, cut]) => {
  const choice = cutOverBudget(itemSegments(texts), tokens);

  expect(choice?.kept).toBe(kept);
  expect(choice?.cut.map((item) => item.number)).toEqual(cut);
});

it('names each cut item by number, first line cut to 100 characters, and length', () => {
  const long = `${'x'.repeat(150)}\nsecond line`;
  const choice = cutOverBudget(itemSegments(['ok', 'y'.repeat(4000), long, 'last']), 1000);

  expect(choice?.cut).toEqual([
    { number: 2, firstLine: 'y'.repeat(100), length: 4000 },
    { number: 3, firstLine: 'x'.repeat(100), length: long.length },
    { number: 4, firstLine: 'last', length: 4 },
  ]);
});

it('bounds the gap for many cut items and names the remaining range', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => `row ${index + 1} ${'x'.repeat(40)}`);
  const choice = cutOverBudget(itemSegments(rows), 4000);
  const gap = describeCutItems(choice?.cut ?? [], '/tmp/tau-codemode-x/output.log');
  const keptLength = rows.slice(0, choice?.kept).join('\n').length;

  expect(gap.length).toBeLessThan(2500);
  expect(keptLength + gap.length).toBeLessThanOrEqual(16_000);
  expect(gap).toContain(`items ${(choice?.kept ?? 0) + 11}-1000`);
  expect(gap).toContain('/tmp/tau-codemode-x/output.log');
  expect(gap.match(/- item /g)).toHaveLength(10);
});

it('keeps nothing when the budget is smaller than the gap reserve', () => {
  expect(cutOverBudget(itemSegments(['a'.repeat(3000), 'b']), 10)?.kept).toBe(0);
});

it('cuts nothing from output shorter than the gap reserve under a smaller budget', () => {
  expect(
    cutOverBudget(itemSegments(Array.from({ length: 10 }, () => 'x'.repeat(107))), 100),
  ).toBeUndefined();
});

const cutFrom = (
  blocks: (string | undefined)[],
  tokens: number,
  hasError = false,
): ReturnType<typeof cutOverBudget> => {
  const cuttable = splitOutput(blocks, hasError)
    .flat()
    .filter((segment) => segment.kind !== 'label');

  return cutOverBudget(cuttable, tokens);
};

it('reports Pi item k as cut item k and the console block without a number', () => {
  const choice = cutFrom(
    [
      label,
      undefined,
      `==> text 1/2 <==\nfirst\n==> text 2/2 <==\n${'b'.repeat(5000)}\n${consoleBlock}`,
    ],
    1000,
  );

  expect(choice?.kept).toBe(1);
  expect(choice?.cut.map((item) => item.number)).toEqual([2, undefined]);
  expect(choice?.cut.map((item) => item.firstLine)).toEqual(['b'.repeat(100), 'c line']);
  expect(describeCutItems(choice?.cut ?? [], undefined)).toContain('- console output: "c line"');
});

it('separates a script error after console output and keeps the small item', () => {
  const error = `Script error:\n${'e'.repeat(5000)}`;

  const choice = cutFrom([`keep me\n<console_output>\nc\n</console_output>\n${error}`], 1000, true);

  expect(choice?.kept).toBe(2);
  expect(choice?.cut.map((item) => item.name)).toEqual(['script error']);
  expect(choice?.cut[0]?.firstLine).toBe('e'.repeat(100));
});

it('separates a script error after an image from the item before it', () => {
  const error = `Script error:\n${'e'.repeat(5000)}`;
  const choice = cutFrom([`first\n${label}`, undefined, error], 1000, true);

  expect(choice?.kept).toBe(1);
  expect(choice?.cut.map((item) => item.name)).toEqual(['script error']);
});

it('names a rejected first-line header by its real first line', () => {
  const choice = cutFrom([`==> text 2/2 <==\n${'b'.repeat(5000)}`], 1000);

  expect(choice?.cut[0]?.firstLine).toBe('==> text 2/2 <==');
});

it.for([
  ['a boundary-sized total', 1999, false],
  ['a total one over the boundary', 2000, true],
] as const)('cuts by Pi newline-joined length for %s', ([, secondLength, isCut]) => {
  const choice = cutOverBudget(itemSegments(['a'.repeat(2000), 'b'.repeat(secondLength)]), 1000);

  expect(choice !== undefined).toBe(isCut);
});

it.for([
  ['an item that fills the keep budget with its separator', 799, 2],
  ['an item one over the keep budget with its separator', 800, 1],
] as const)('keeps %s', ([, secondLength, kept]) => {
  const choice = cutOverBudget(
    itemSegments(['a'.repeat(700), 'b'.repeat(secondLength), 'c'.repeat(3000)]),
    1000,
  );

  expect(choice?.kept).toBe(kept);
});

it('names cut items without a number and gives no range for them', () => {
  const cut = Array.from({ length: 11 }, (_, index) => ({
    number: index + 1,
    firstLine: `row ${index + 1}`,
    length: 10,
  }));

  const withoutNumber = describeCutItems(
    [...cut.slice(0, 10), { name: 'console output', firstLine: 'c', length: 7 }],
    '/tmp/out.log',
  );

  expect(withoutNumber).toContain('1 more items, 7 characters');
  expect(withoutNumber).not.toContain('- items ');

  const mixed = describeCutItems(
    [...cut, { name: 'console output', firstLine: 'c', length: 7 }],
    '/tmp/out.log',
  );

  expect(mixed).toContain('items 11-11: 2 more items, 17 characters');
});

it('says when the full output could not be saved and names a single cut item', () => {
  const gap = describeCutItems([{ number: 3, firstLine: 'x', length: 9 }], undefined);

  expect(gap).toContain('could not be saved');
  expect(gap).not.toContain('more items');
});

it('keeps a first item that fills the keep budget exactly', () => {
  expect(cutOverBudget(itemSegments(['a'.repeat(1500), 'b'.repeat(3000)]), 1000)?.kept).toBe(1);
});
