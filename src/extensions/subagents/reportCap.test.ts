import { expect, it } from 'vitest';

import { capReportText } from './reportCap.js';

it('keeps summary and evidence within the cap uncut', () => {
  expect(capReportText('s'.repeat(7000), ['e'.repeat(1000)])).toBeUndefined();
});

it.each([
  {
    rule: 'summary alone over the cap',
    summary: 's'.repeat(8001),
    evidence: [],
    kept: { head: 's'.repeat(3997), tail: 's'.repeat(3998), evidence: [] },
  },
  {
    rule: 'evidence over the cap',
    summary: 's'.repeat(6000),
    evidence: ['e'.repeat(3000), 'kept-out'],
    kept: { head: 's'.repeat(6000), tail: '', evidence: ['e'.repeat(2000)] },
  },
  {
    rule: 'evidence cut inside a surrogate pair',
    summary: 's'.repeat(7999),
    evidence: ['😀'],
    kept: { head: 's'.repeat(7999), tail: '', evidence: [''] },
  },
  {
    rule: 'summary head cut inside a surrogate pair',
    summary: `${'a'.repeat(3996)}😀${'b'.repeat(6000)}`,
    evidence: [],
    kept: { head: 'a'.repeat(3996), tail: 'b'.repeat(3998), evidence: [] },
  },
  {
    rule: 'summary tail cut inside a surrogate pair',
    summary: `${'a'.repeat(5000)}😀${'b'.repeat(3997)}`,
    evidence: [],
    kept: { head: 'a'.repeat(3997), tail: 'b'.repeat(3997), evidence: [] },
  },
  {
    rule: 'head-and-tail split keeps the closing concerns',
    summary: `## Changes\n${'s'.repeat(10_000)}\n## Concerns\nRisky migration.`,
    evidence: ['e'],
    kept: { head: '## Changes\n', tail: '\n## Concerns\nRisky migration.', evidence: [] },
  },
])('$rule', ({ summary, evidence, kept }) => {
  const result = capReportText(summary, evidence);

  expect(result?.summary.startsWith(kept.head)).toBe(true);
  expect(result?.summary.endsWith(kept.tail)).toBe(true);
  expect(result?.summary.isWellFormed()).toBe(true);
  expect(result?.summary.length).toBeLessThanOrEqual(8000);
  expect(result?.summary.includes('😀')).toBe(false);
  expect(result?.evidence).toEqual(kept.evidence);
});
