import { expect, it } from 'vitest';

import { decideNoticeDelivery } from './noticeDelivery.js';
import type { NoticeDeliveryFacts, NoticeDeliveryStep } from './noticeDelivery.js';

const busy: NoticeDeliveryFacts = { piIdle: false, runActive: false, agentRunning: false };

it.each<{ name: string; facts: NoticeDeliveryFacts; step: NoticeDeliveryStep }>([
  { name: 'wakes an idle parent', facts: { ...busy, piIdle: true }, step: 'wake' },
  {
    name: 'wakes a parent that went idle before its run settled',
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
  {
    name: 'steers when no session context is bound',
    facts: { ...busy, piIdle: undefined },
    step: 'steer',
  },
])('$name', ({ facts, step }) => {
  expect(decideNoticeDelivery(facts)).toBe(step);
});
