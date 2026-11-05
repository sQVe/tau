import { expect, it } from 'vitest';

import { decideInboxEventScan } from './eventDecision.js';
import type { InboxEventFact, InboxEventScan } from './eventDecision.js';

const table: { name: string; fact: InboxEventFact; scan: InboxEventScan }[] = [
  { name: 'scans on a labels event', fact: { method: 'event', type: 'labels' }, scan: 'scan' },
  { name: 'scans on a missed snapshot', fact: { method: 'missed' }, scan: 'scan' },
  { name: 'ignores a heartbeat', fact: { method: 'heartbeat' }, scan: 'ignore' },
  { name: 'ignores a status event', fact: { method: 'event', type: 'status' }, scan: 'ignore' },
  { name: 'ignores an event without a type', fact: { method: 'event' }, scan: 'ignore' },
  { name: 'ignores an unknown notification', fact: { method: 'other' }, scan: 'ignore' },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideInboxEventScan(row.fact)).toBe(row.scan);
});
