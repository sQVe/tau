import { expect, it } from 'vitest';

import {
  decideBudgetRefusal,
  defaultOutputTokens,
  raiseOutputCap,
  readOutputBudget,
} from './budget.js';

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

it.for(['-1', '"8000"', '8000.5'])('leaves max_output_tokens %s for Pi to reject', (value) => {
  const source = `// @options: {"max_output_tokens": ${value}}\n${body}`;

  expect(raiseOutputCap(source)).toBe(source);
});

it.for(['5', '"text"', 'null', '[1]', 'true'])(
  'leaves options line JSON %s that is not an object for Pi to report',
  (value) => {
    const source = `// @options: ${value}\n${body}`;

    expect(raiseOutputCap(source)).toBe(source);
  },
);

it.for([
  ['max_output_tokens 0', '{"max_output_tokens": 0}'],
  ['no max_output_tokens', '{"timeout_ms": 5000}'],
])('raises the cap of options with %s', ([, options]) => {
  const raised = raiseOutputCap(`// @options: ${options}\n${body}`);

  expect(readOutputBudget(raised)).toBe(100_000_000);
  expect(raised.split('\n')[1]).toBe(body);
});

it.for(['"8000"', '8000.5'])('does not refuse max_output_tokens %s as a raise', (value) => {
  const source = `// @options: {"max_output_tokens": ${value}}\n${body}`;

  expect(decideBudgetRefusal(source)).toBeUndefined();
  expect(readOutputBudget(source)).toBe(defaultOutputTokens);
});

it('reads options and the reason line with leading whitespace', () => {
  const options = '  \t// @options: {"max_output_tokens": 8000}';

  expect(readOutputBudget(`${options}\n${body}`)).toBe(8000);
  expect(decideBudgetRefusal(`${options}\n${body}`)).toBeDefined();
  expect(decideBudgetRefusal(`${options}\n  \t// @budget: why\n${body}`)).toBeUndefined();
  expect(raiseOutputCap(`${options}\n${body}`).split('\n')).toHaveLength(2);
  expect(readOutputBudget(raiseOutputCap(`${options}\n${body}`))).toBe(100_000_000);
});

it('refuses a one-line script that raises the budget without a reason', () => {
  expect(decideBudgetRefusal('// @options: {"max_output_tokens": 8000}')).toBeDefined();
});

it('does not read a first line that is not an options line', () => {
  const first = `${'x'.repeat('// @options:'.length)}{"max_output_tokens": 8000}`;
  const source = `${first}\n${body}`;

  expect(readOutputBudget(source)).toBe(defaultOutputTokens);
  expect(decideBudgetRefusal(source)).toBeUndefined();
  expect(raiseOutputCap(source)).toBe(`// @options: {"max_output_tokens":100000000}\n${source}`);
});

it('leaves an options line with leading whitespace that Pi rejects for Pi to report', () => {
  const source = `  // @options: {not json}\n${body}`;

  expect(raiseOutputCap(source)).toBe(source);
});

it('leaves options with a carriage return inside a JSON string for Pi to report', () => {
  const source = `// @options: {"label": "a\rb", "max_output_tokens": 8000}\n${body}`;

  expect(raiseOutputCap(source)).toBe(source);
  expect(decideBudgetRefusal(source)).toBeUndefined();
  expect(readOutputBudget(source)).toBe(defaultOutputTokens);
});
