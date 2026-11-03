export interface DeliveryFacts {
  piIdle: boolean;
  // Tau saw agent_start and not yet agent_settled. Pi's automatic compaction runs in this span,
  // after the agent loop has ended.
  runActive: boolean;
  agentRunning: boolean;
}

export type DeliveryStep = 'wake' | 'steer' | 'queue';

export const decideDeliveryStep = (facts: DeliveryFacts): DeliveryStep => {
  if (facts.piIdle) {
    return 'wake';
  }

  if (facts.runActive || facts.agentRunning) {
    return 'steer';
  }

  return 'queue';
};
