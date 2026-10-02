// Decides how a worker notice reaches the parent from facts the caller read. tests/structure.test.ts
// keeps this module pure.

export interface NoticeDeliveryFacts {
  // Undefined when no session context is bound, so only Pi can decide.
  piIdle: boolean | undefined;
  // Tau saw agent_start and not yet agent_settled. Pi's automatic compaction runs in this span,
  // after the agent loop has ended.
  runActive: boolean;
  // Pi's agent loop is running. It starts before Pi calls the agent_start handlers.
  agentRunning: boolean;
}

// wake: a nextTurn message and a prompt that starts a turn. steer: Pi queues the notice into the
// run. queue: a nextTurn message that waits for the next prompt.
export type NoticeDeliveryStep = 'wake' | 'steer' | 'queue';

export const decideNoticeDelivery = (facts: NoticeDeliveryFacts): NoticeDeliveryStep => {
  if (facts.piIdle === true) {
    return 'wake';
  }

  if (facts.piIdle === undefined || facts.runActive || facts.agentRunning) {
    return 'steer';
  }

  // Pi is busy without a run, as in a manual compaction. A triggerTurn notice would start a turn
  // beside it.
  return 'queue';
};
