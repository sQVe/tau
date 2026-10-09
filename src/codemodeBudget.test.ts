import { expect, it } from 'vitest';

import {
  cutOverBudget,
  describeCutItems,
  decideBudgetRefusal,
  defaultOutputTokens,
  readOutputBudget,
  raiseOutputCap,
} from './codemodeBudget.js';

const body = 'text("done");';

it.for([
  ['no options line', body, false],
  ['a budget at 4,000', `// @options: {"max_output_tokens": 4000}\n${body}`, false],
  [
    'a budget above 4,000 with a reason line',
    `// @options: {"max_output_tokens": 8000}\n// @budget: Reading three whole specs.\n${body}`,
    false,
  ],
  [
    'a budget above 4,000 with an empty reason',
    `// @options: {"max_output_tokens": 8000}\n// @budget:   \n${body}`,
    true,
  ],
  [
    'a budget above 4,000 with no reason line',
    `// @options: {"max_output_tokens": 8000}\n${body}`,
    true,
  ],
  [
    'a reason line that is not the second line',
    `// @options: {"max_output_tokens": 8000}\n${body}\n// @budget: Late.`,
    true,
  ],
  ['options that Pi rejects', `// @options: {not json}\n${body}`, false],
] as const)('refuses a script with %s: %s', ([, source, refused]) => {
  const refusal = decideBudgetRefusal(source);

  expect(refusal !== undefined).toBe(refused);
  expect(refusal ?? '// @budget:').toContain('// @budget:');
});

it('reads the budget from the options line or falls back to the default', () => {
  expect(readOutputBudget(body)).toBe(defaultOutputTokens);
  expect(readOutputBudget(`// @options: {"timeout_ms": 5000}\n${body}`)).toBe(defaultOutputTokens);
  expect(readOutputBudget(`// @options: {"max_output_tokens": 1500}\n${body}`)).toBe(1500);
});

it('raises the cap on the options line and keeps the other fields and lines', () => {
  const raised = raiseOutputCap(
    `// @options: {"max_output_tokens": 1500, "timeout_ms": 5000}\n// @budget: x\n${body}`,
  );

  expect(raised.split('\n').slice(1)).toEqual(['// @budget: x', body]);

  expect(JSON.parse(raised.split('\n')[0]?.replace('// @options:', '') ?? '')).toEqual({
    max_output_tokens: 100_000_000,
    timeout_ms: 5000,
  });

  expect(readOutputBudget(raised)).toBe(100_000_000);
});

it('raises the cap of a script that is only an options line', () => {
  const raised = raiseOutputCap('// @options: {"max_output_tokens": 1500}');

  expect(raised).toBe('// @options: {"max_output_tokens":100000000}');
});

it('adds an options line when the script has none', () => {
  const raised = raiseOutputCap(body);

  expect(raised.split('\n')[1]).toBe(body);
  expect(readOutputBudget(raised)).toBe(100_000_000);
});

it('leaves options that Pi rejects for Pi to report', () => {
  const source = `// @options: {not json}\n${body}`;

  expect(raiseOutputCap(source)).toBe(source);
});

it('chooses no cut for items within the budget', () => {
  expect(cutOverBudget(['a'.repeat(10), 'b'.repeat(10)], 6)).toBeUndefined();
});

it.for([
  ['an item over the budget', ['a'.repeat(1000), 'b'.repeat(3000), 'c'.repeat(2)], 1000, 1, [2, 3]],
  ['a first item over the budget', ['a'.repeat(5000), 'b'], 1000, 0, [1, 2]],
] as const)('keeps whole items in order for %s', ([, texts, tokens, kept, cut]) => {
  const choice = cutOverBudget(texts, tokens);

  expect(choice?.kept).toBe(kept);
  expect(choice?.cut.map((item) => item.number)).toEqual(cut);
});

it('names each cut item by number, first line cut to 100 characters, and length', () => {
  const long = `${'x'.repeat(150)}\nsecond line`;
  const choice = cutOverBudget(['ok', 'y'.repeat(4000), long, 'last'], 1000);

  expect(choice?.cut).toEqual([
    { number: 2, firstLine: 'y'.repeat(100), length: 4000 },
    { number: 3, firstLine: 'x'.repeat(100), length: long.length },
    { number: 4, firstLine: 'last', length: 4 },
  ]);
});

it.for(['-1', '"8000"', '8000.5'])('leaves max_output_tokens %s for Pi to reject', (value) => {
  const source = `// @options: {"max_output_tokens": ${value}}\n${body}`;

  expect(raiseOutputCap(source)).toBe(source);
});

it('bounds the gap for many cut items and names the remaining range', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => `row ${index + 1} ${'x'.repeat(40)}`);
  const choice = cutOverBudget(rows, 4000);
  const gap = describeCutItems(choice?.cut ?? [], '/tmp/tau-codemode-x/output.log');
  const keptLength = rows.slice(0, choice?.kept).join('\n').length;

  expect(gap.length).toBeLessThan(2500);
  expect(keptLength + gap.length).toBeLessThanOrEqual(16_000);
  expect(gap).toContain(`items ${(choice?.kept ?? 0) + 11}-1000`);
  expect(gap).toContain('/tmp/tau-codemode-x/output.log');
  expect(gap.match(/- item /g)).toHaveLength(10);
});

it('keeps nothing when the budget is smaller than the gap reserve', () => {
  expect(cutOverBudget(['a'.repeat(3000), 'b'], 10)?.kept).toBe(0);
});

it('cuts nothing from output shorter than the gap reserve under a smaller budget', () => {
  expect(
    cutOverBudget(
      Array.from({ length: 10 }, () => 'x'.repeat(107)),
      100,
    ),
  ).toBeUndefined();
});
