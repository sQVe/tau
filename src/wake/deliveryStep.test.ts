import { expect, it } from 'vitest';

import { decideDeliveryStep } from './deliveryStep.js';
import type { DeliveryFacts, DeliveryStep } from './deliveryStep.js';

const busy: DeliveryFacts = { piIdle: false, runActive: false, agentRunning: false };

const table: { name: string; facts: DeliveryFacts; step: DeliveryStep }[] = [
  { name: 'wakes an idle session', facts: { ...busy, piIdle: true }, step: 'wake' },
  {
    name: 'wakes a session that went idle before its run settled',
    facts: { ...busy, piIdle: true, runActive: true },
    step: 'wake',
  },
  {
    name: 'steers into an active run, automatic compaction included',
    facts: { ...busy, runActive: true },
    step: 'steer',
  },
  {
    name: 'steers into a run that started before agent_start reached Tau',
    facts: { ...busy, agentRunning: true },
    step: 'steer',
  },
  {
    name: 'queues for the next prompt while Pi is busy without a run',
    facts: busy,
    step: 'queue',
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, step }) => {
  expect(decideDeliveryStep(facts)).toBe(step);
});
