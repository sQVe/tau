import { expect, it } from 'vitest';

import {
  cutOverBudget,
  describeCutItems,
  decideBudgetRefusal,
  defaultOutputTokens,
  readOutputBudget,
  raiseOutputCap,
  splitOutput,
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

const label = '[Image saved to /tmp/x.png (png)]';
const consoleBlock = '<console_output>\nc line\nmore\n</console_output>';

it.each([
  [
    'numbered items split with their numbers',
    ['==> text 1/2 <==\nfirst\nline\n==> text 2/2 <==\nsecond'],
    [
      [
        { kind: 'item', text: '==> text 1/2 <==\nfirst\nline', number: 1 },
        { kind: 'item', text: '==> text 2/2 <==\nsecond', number: 2 },
      ],
    ],
  ],
  [
    'one item has no header and stays whole',
    ['only one'],
    [[{ kind: 'item', text: 'only one', number: 1 }]],
  ],
  [
    'a header line inside a single item is not a boundary',
    ['prefix\n==> text 2/2 <==\nbody'],
    [[{ kind: 'item', text: 'prefix\n==> text 2/2 <==\nbody', number: 1 }]],
  ],
  [
    'a leading header that is not 1/M is not a boundary',
    ['==> text 2/2 <==\nbody'],
    [[{ kind: 'item', text: '==> text 2/2 <==\nbody', number: 1 }]],
  ],
  [
    'headers out of order stay whole',
    ['==> text 1/3 <==\na\n==> text 3/3 <==\nb\n==> text 2/3 <==\nc'],
    [
      [
        {
          kind: 'item',
          text: '==> text 1/3 <==\na\n==> text 3/3 <==\nb\n==> text 2/3 <==\nc',
          number: 1,
        },
      ],
    ],
  ],
  [
    'a trailing console block is its own segment',
    [`keep me\n${consoleBlock}`],
    [
      [
        { kind: 'item', text: 'keep me', number: 1 },
        { kind: 'console', text: consoleBlock },
      ],
    ],
  ],
  [
    'an image label is pinned and the numbers continue across the image',
    [label, undefined, '==> text 1/2 <==\nfirst\n==> text 2/2 <==\nb'],
    [
      [{ kind: 'label', text: label }],
      [],
      [
        { kind: 'item', text: '==> text 1/2 <==\nfirst', number: 1 },
        { kind: 'item', text: '==> text 2/2 <==\nb', number: 2 },
      ],
    ],
  ],
  [
    'items on both sides of an image count as one sequence',
    [`==> text 1/2 <==\nfirst\n${label}`, undefined, '==> text 2/2 <==\nb'],
    [
      [
        { kind: 'item', text: '==> text 1/2 <==\nfirst', number: 1 },
        { kind: 'label', text: label },
      ],
      [],
      [{ kind: 'item', text: '==> text 2/2 <==\nb', number: 2 }],
    ],
  ],
] as [string, (string | undefined)[], unknown[]][])(
  'splits Pi output: %s',
  (_name, blocks, expected) => {
    expect(splitOutput(blocks)).toMatchObject(expected);
  },
);

const cutFrom = (
  blocks: (string | undefined)[],
  tokens: number,
  hasError = false,
): ReturnType<typeof cutOverBudget> => {
  const cuttable = splitOutput(blocks, hasError)
    .flat()
    .filter((segment) => segment.kind !== 'label');

  return cutOverBudget(
    cuttable.map((segment) => segment.text),
    tokens,
    cuttable,
  );
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

it('records the separator Pi used so kept segments rebuild its text', () => {
  const [segments = []] = splitOutput([
    '==> text 1/2 <==\nfirst\n==> text 2/2 <==\nsecond\n' + consoleBlock,
  ]);

  expect(segments.map((segment) => segment.separator)).toEqual(['', '\n', '\n']);

  expect(
    segments
      .map((segment, position) => (position === 0 ? '' : segment.separator) + segment.text)
      .join(''),
  ).toBe('==> text 1/2 <==\nfirst\n==> text 2/2 <==\nsecond\n' + consoleBlock);
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

it('treats an unexpected error-shaped tail as script text when Pi reported no error', () => {
  const [segments = []] = splitOutput(['keep\nScript error:\nlooks like one']);

  expect(segments.map((segment) => segment.kind)).toEqual(['item']);
});
