import { expect, it } from 'vitest';

import { decideEventScan } from './eventDecision.js';
import type { EventFact, EventScanAction } from './eventDecision.js';

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
