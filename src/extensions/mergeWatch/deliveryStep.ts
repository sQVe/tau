// Decides how a merge watch turn reaches the session from facts the caller read.
// tests/structure.test.ts keeps this module pure.

export interface DeliveryFacts {
  piIdle: boolean;
  // Tau saw agent_start and not yet agent_settled. Pi's automatic compaction runs in this span,
  // after the agent loop has ended.
  runActive: boolean;
  // Pi's agent loop is running. It starts before Pi calls the agent_start handlers.
  agentRunning: boolean;
}

// wake: a triggerTurn message that starts a turn. steer: Pi queues the message into the run. queue:
// a nextTurn message that waits for the next prompt.
export type DeliveryStep = 'wake' | 'steer' | 'queue';

export const decideDeliveryStep = (facts: DeliveryFacts): DeliveryStep => {
  if (facts.piIdle) {
    return 'wake';
  }

  if (facts.runActive || facts.agentRunning) {
    return 'steer';
  }

  // Pi is busy without a run, as in a manual compaction. A triggerTurn message would start a turn
  // beside it.
  return 'queue';
};
