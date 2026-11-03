import { expect, it } from 'vitest';

import { decideEventScan, decideReconnect } from './eventDecision.js';
import type { EventFact, EventScanAction, ReconnectPlan } from './eventDecision.js';

const table: { name: string; fact: EventFact; action: EventScanAction }[] = [
  {
    name: 'scans on a labels event',
    fact: { method: 'event', type: 'labels' },
    action: 'scan',
  },
  {
    name: 'scans on a finished event',
    fact: { method: 'event', type: 'finished' },
    action: 'scan',
  },
  {
    name: 'scans on a missed snapshot',
    fact: { method: 'missed' },
    action: 'scan',
  },
  {
    name: 'ignores a heartbeat',
    fact: { method: 'heartbeat' },
    action: 'ignore',
  },
  {
    name: 'ignores a status event',
    fact: { method: 'event', type: 'status' },
    action: 'ignore',
  },
  {
    name: 'ignores an event without a type',
    fact: { method: 'event' },
    action: 'ignore',
  },
  {
    name: 'ignores an unknown notification',
    fact: { method: 'other' },
    action: 'ignore',
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { fact, action }) => {
  expect(decideEventScan(fact)).toBe(action);
});

const reconnectTable: { name: string; attempt: number; plan: ReconnectPlan }[] = [
  { name: 'uses the first retry delay', attempt: 0, plan: { delay: 5_000, lasting: false } },
  { name: 'uses the second retry delay', attempt: 1, plan: { delay: 15_000, lasting: false } },
  { name: 'uses the third retry delay', attempt: 2, plan: { delay: 45_000, lasting: false } },
  {
    name: 'caps at the last delay and reports a lasting failure',
    attempt: 3,
    plan: { delay: 45_000, lasting: true },
  },
  {
    name: 'keeps the last delay and the lasting failure for later attempts',
    attempt: 9,
    plan: { delay: 45_000, lasting: true },
  },
];

it.each(reconnectTable.map((row) => [row.name, row] as const))('%s', (_name, { attempt, plan }) => {
  expect(decideReconnect(attempt)).toEqual(plan);
});
