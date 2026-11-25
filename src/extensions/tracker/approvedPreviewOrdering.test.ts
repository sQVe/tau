import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { array, assert, constantFrom, property } from 'fast-check';
import { expect, it } from 'vitest';

import { resolvePropertySeed } from '../../../tests/propertySeedHarness.ts';
import { approvedPreviewLines } from './approvedPreview.js';
import { answer, askCall, askResult, cancelOption, question } from './fixtures/approvedPreview.js';

type OrderKind = 'first call' | 'second call' | 'result';

const orderKind = constantFrom<OrderKind>('first call', 'second call', 'result');

const entryFactories: Record<OrderKind, () => SessionEntry> = {
  'first call': () => askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
  'second call': () => askCall('call-1', [question([cancelOption('Cancel ME-2: Title')])]),
  result: () => askResult('call-1', [answer]),
};

const entryOf = (kind: OrderKind): SessionEntry => entryFactories[kind]();

const linesOf = (kind: OrderKind): string[] =>
  kind === 'first call' ? ['Cancel ME-1: Title'] : ['Cancel ME-2: Title'];

const expectedLines = (order: readonly OrderKind[]): string[] => {
  const lines: string[] = [];
  let firstCall: OrderKind | undefined;
  let callCount = 0;

  for (const kind of order) {
    if (kind === 'result') {
      if (callCount === 1 && firstCall !== undefined) {
        lines.push(...linesOf(firstCall));
      }

      continue;
    }

    firstCall ??= kind;

    callCount += 1;
  }

  return lines;
};

it('gives the lines of the only call before a result and none after a duplicate call', () => {
  const seed = resolvePropertySeed();

  assert(
    property(array(orderKind, { minLength: 3, maxLength: 6 }), (order) => {
      const branch = order.map(entryOf);

      expect(approvedPreviewLines(branch), order.join(' then ')).toEqual(expectedLines(order));
    }),
    { seed, numRuns: 100 },
  );
});
