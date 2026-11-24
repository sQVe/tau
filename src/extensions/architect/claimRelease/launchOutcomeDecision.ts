export type LaunchOutcome = 'created' | 'notCreated';

export interface LaunchOutcomeFacts {
  exitCode: number | null;
  killed: boolean;
  aborted: boolean;
  replyTerminal: 'valid' | 'missing' | 'malformed';
}

const completed = (facts: LaunchOutcomeFacts): boolean => facts.exitCode === 0 && !facts.killed;

const created = (facts: LaunchOutcomeFacts): boolean =>
  completed(facts) && !facts.aborted && facts.replyTerminal === 'valid';

export const launchOutcomeDecision = (facts: LaunchOutcomeFacts): LaunchOutcome =>
  created(facts) ? 'created' : 'notCreated';
