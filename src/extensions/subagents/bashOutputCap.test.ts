import { expect, it } from 'vitest';

import { decideBashOutputCap } from './bashOutputCap.js';

const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => String(from + index)).join('\n');

const long = 'x'.repeat(8001);

const successfulBash = (text: string) => ({
  toolName: 'bash',
  isError: false,
  content: [{ type: 'text', text }],
});

it.each([
  { rule: 'output within the cap', result: successfulBash('x'.repeat(8000)) },
  { rule: 'another tool', result: { ...successfulBash(long), toolName: 'read' } },
  { rule: 'a failed command', result: { ...successfulBash(long), isError: true } },
  {
    rule: 'an image part',
    result: { ...successfulBash(long), content: [{ type: 'image', data: long }] },
  },
  {
    rule: 'more than one part',
    result: {
      ...successfulBash(long),
      content: [
        { type: 'text', text: long },
        { type: 'text', text: 'note' },
      ],
    },
  },
  { rule: 'no content', result: { ...successfulBash(long), content: [] } },
])('leaves $rule whole', ({ result }) => {
  expect(decideBashOutputCap(result)).toBeUndefined();
});

it.each([
  {
    rule: 'short lines cut at line boundaries',
    text: lines(1, 3000),
    head: /^1\n2\n3\n[\s\S]*\n\d+$/u,
    tail: /^\d+\n[\s\S]*\n2999\n3000$/u,
  },
  {
    rule: 'one long line falls back to character cuts',
    text: `${'x'.repeat(20_000)}\nDone`,
    head: /^x{2000}$/u,
    tail: /^x{5495}\nDone$/u,
  },
  {
    rule: "Pi's closing full-output note stays in the tail",
    text: `${lines(1, 3000)}\n\n[Showing lines 1-3000 of 5000. Full output: /tmp/pi-bash-1.log]`,
    head: /^1\n/u,
    tail: /Full output: \/tmp\/pi-bash-1\.log\]$/u,
  },
  {
    rule: 'head character cut inside a surrogate pair',
    text: `${'a'.repeat(1999)}😀${'b'.repeat(9000)}`,
    head: /^a{1999}$/u,
    tail: /^b{5500}$/u,
  },
  {
    rule: 'tail character cut inside a surrogate pair',
    text: `${'a'.repeat(9000)}😀${'b'.repeat(5499)}`,
    head: /^a{2000}$/u,
    tail: /^b{5499}$/u,
  },
])('$rule', ({ text, head, tail }) => {
  const result = decideBashOutputCap(successfulBash(text));

  expect(result?.head).toMatch(head);
  expect(result?.tail).toMatch(tail);
  expect(result?.head.isWellFormed()).toBe(true);
  expect(result?.tail.isWellFormed()).toBe(true);
  expect((result?.head.length ?? 0) + (result?.tail.length ?? 0)).toBeGreaterThan(6000);
  expect((result?.head.length ?? 0) + (result?.tail.length ?? 0)).toBeLessThanOrEqual(7500);
  expect(result?.text).toBe(text);
  expect(result?.cut).toBe(text.length - (result?.head.length ?? 0) - (result?.tail.length ?? 0));
});

it('keeps whole lines when they fill exactly half the head and tail room', () => {
  const result = decideBashOutputCap(
    successfulBash(`${'a'.repeat(1000)}\n${'x'.repeat(20_000)}\n${'b'.repeat(2750)}`),
  );

  expect(result?.head).toBe('a'.repeat(1000));
  expect(result?.tail).toBe('b'.repeat(2750));
});

it('cuts characters when the last line fills less than half the tail room', () => {
  const result = decideBashOutputCap(successfulBash(`${'x'.repeat(20_000)}\n${'b'.repeat(2749)}`));

  expect(result?.tail).toBe(`${'x'.repeat(2750)}\n${'b'.repeat(2749)}`);
});
