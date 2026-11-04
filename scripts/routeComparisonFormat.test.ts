import { describe, expect, it } from 'vitest';

import { before, switchTime } from './fixtures/routeComparisonTimes.js';
import { formatRouteComparisonReport } from './routeComparisonFormat.js';
import { routeComparisonReport } from './routeComparisonReport.js';
import type { ComparisonOptions, ParsedRecord, RouteRecord } from './routeComparisonReport.js';

const options: ComparisonOptions = { profile: 'worker', label: 'routine', switch: switchTime };

const parsed = (fields: Partial<RouteRecord> & { id: string }): ParsedRecord => ({
  kind: 'record',
  record: {
    createdAt: before,
    profile: 'worker',
    label: 'routine',
    model: 'model-a',
    cwd: '/repo',
    parentSession: '/session.jsonl',
    ...fields,
  },
});

const launches = (count: number) =>
  Array.from({ length: count }, (_, index) => parsed({ id: `launch-${index}` }));

const beforeSection = (output: string) => output.slice(0, output.indexOf('After switch'));

describe('formatRouteComparisonReport', () => {
  it.each([
    { rule: '19 launches', count: 19, marked: true },
    { rule: '20 launches', count: 20, marked: false },
  ])('marks a side of $rule as a small sample: $marked', ({ count, marked }) => {
    const output = formatRouteComparisonReport(
      routeComparisonReport(launches(count), options),
      false,
    );

    expect(beforeSection(output).includes('small sample')).toBe(marked);
  });

  it.each([
    { rule: 'a linked clean review', reviews: [{ summary: 'No findings.' }], share: '0%' },
    { rule: 'a linked review with findings', reviews: [{ summary: 'One defect.' }], share: '100%' },
    { rule: 'no linked review', reviews: [], share: 'none' },
  ])('prints the reviewer findings share for $rule', ({ reviews, share }) => {
    const reviewRecords = reviews.map(({ summary }, index) =>
      parsed({
        id: `review-${index}`,
        profile: 'reviewer',
        label: undefined,
        createdAt: before + 1,
        outcome: 'success',
        summary,
      }),
    );

    const report = routeComparisonReport([parsed({ id: 'launch' }), ...reviewRecords], options);

    const reviewerLine = beforeSection(formatRouteComparisonReport(report, false))
      .split('\n')
      .find((line) => line.includes('reviewer findings'));

    expect(reviewerLine).toContain(`${share} with findings`);
  });

  it.each([
    { rule: 'with --model', model: 'model-b', shown: true },
    { rule: 'without --model', model: undefined, shown: false },
  ])('names the after-side model filter $rule', ({ model, shown }) => {
    const report = routeComparisonReport([], {
      ...options,
      ...(model === undefined ? {} : { model }),
    });

    const output = formatRouteComparisonReport(report, false);

    expect(output.includes('model-b')).toBe(shown);
  });
});
