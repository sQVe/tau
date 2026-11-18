import { expect, it } from 'vitest';

import { decideFallbackRoute } from './fallbackRoute.js';
import type { FallbackRouteDecision, FallbackRouteFacts } from './fallbackRoute.js';

const state = (consecutiveRetries: number, onFallback: boolean) => ({
  version: 1 as const,
  consecutiveRetries,
  onFallback,
});

const routeFacts = (overrides: Partial<FallbackRouteFacts>): FallbackRouteFacts => ({
  reason: 'retry',
  state: undefined,
  previousOnFallback: false,
  fallbackAtRetry: 5,
  ...overrides,
});

const table: {
  name: string;
  facts: FallbackRouteFacts;
  expected: FallbackRouteDecision;
}[] = [
  {
    name: 'a user request returns to the primary and clears the state',
    facts: routeFacts({ reason: 'user', state: state(3, true) }),
    expected: { target: 'primary', state: state(0, false) },
  },
  {
    name: 'the first retry without state counts one retry on the primary',
    facts: routeFacts({ state: undefined }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry below the configured retry stays on the primary',
    facts: routeFacts({ state: state(3, false) }),
    expected: { target: 'primary', state: state(4, false) },
  },
  {
    name: 'retry at the configured retry switches to the fallback',
    facts: routeFacts({ state: state(4, false) }),
    expected: { target: 'fallback', state: state(5, true) },
  },
  {
    name: 'a retry while on the fallback stays on the fallback',
    facts: routeFacts({ state: state(0, true) }),
    expected: { target: 'fallback', state: state(1, true) },
  },
  {
    name: 'the first retry switches when the configured retry is one',
    facts: routeFacts({ state: undefined, fallbackAtRetry: 1 }),
    expected: { target: 'fallback', state: state(1, true) },
  },
  {
    name: 'a continuation on the fallback stays on the fallback and clears the retry count',
    facts: routeFacts({ reason: 'continuation', state: state(5, true) }),
    expected: { target: 'fallback', state: state(0, true) },
  },
  {
    name: 'a continuation without state stays on the primary',
    facts: routeFacts({ reason: 'continuation', state: undefined }),
    expected: { target: 'primary', state: state(0, false) },
  },
  {
    name: 'a continuation with a zero retry count on the primary writes no state',
    facts: routeFacts({ reason: 'continuation', state: state(0, false) }),
    expected: { target: 'primary' },
  },
  {
    name: 'a continuation with a zero retry count on the fallback writes no state',
    facts: routeFacts({ reason: 'continuation', state: state(0, true) }),
    expected: { target: 'fallback' },
  },
  {
    name: 'a direct request after a fallback response routes to the fallback',
    facts: routeFacts({ reason: 'direct', state: undefined, previousOnFallback: true }),
    expected: { target: 'fallback' },
  },
  {
    name: 'a direct request after a primary response routes to the primary',
    facts: routeFacts({ reason: 'direct', state: undefined, previousOnFallback: false }),
    expected: { target: 'primary' },
  },
  {
    name: 'a direct request ignores the saved state',
    facts: routeFacts({ reason: 'direct', state: state(3, true), previousOnFallback: false }),
    expected: { target: 'primary' },
  },
  {
    name: 'a retry with a state of version 2 counts one retry on the primary',
    facts: routeFacts({ state: { version: 2, consecutiveRetries: 4, onFallback: false } }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry with a negative retry count counts one retry on the primary',
    facts: routeFacts({ state: { version: 1, consecutiveRetries: -1, onFallback: false } }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry with a missing key counts one retry on the primary',
    facts: routeFacts({ state: { version: 1, onFallback: false } }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry with an extra key counts one retry on the primary',
    facts: routeFacts({
      state: { version: 1, consecutiveRetries: 4, onFallback: false, extra: true },
    }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry with a missing key and an extra key counts one retry on the primary',
    facts: routeFacts({ state: { version: 1, consecutiveRetries: 4, extra: true } }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry with a fractional retry count counts one retry on the primary',
    facts: routeFacts({ state: { version: 1, consecutiveRetries: 1.5, onFallback: false } }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry with a text retry count counts one retry on the primary',
    facts: routeFacts({ state: { version: 1, consecutiveRetries: '4', onFallback: false } }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry with a non-boolean fallback flag counts one retry on the primary',
    facts: routeFacts({ state: { version: 1, consecutiveRetries: 0, onFallback: 'yes' } }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry with a text state counts one retry on the primary',
    facts: routeFacts({ state: 'text' }),
    expected: { target: 'primary', state: state(1, false) },
  },
  {
    name: 'a retry with a null state counts one retry on the primary',
    facts: routeFacts({ state: null }),
    expected: { target: 'primary', state: state(1, false) },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, expected }) => {
  expect(decideFallbackRoute(facts)).toStrictEqual(expected);
});
