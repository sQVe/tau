export type LaunchOutcome = 'created' | 'refused' | 'unknown';

export interface LaunchOutcomeFacts {
  ran: boolean;
  exitCode: number | null;
  killed: boolean;
  aborted: boolean;
  timedOut: boolean;
  replyTerminal: 'valid' | 'missing' | 'malformed';
}

const completed = (facts: LaunchOutcomeFacts): boolean =>
  facts.exitCode === 0 && !facts.killed && !facts.timedOut;

const validReply = (facts: LaunchOutcomeFacts): boolean =>
  !facts.aborted && facts.replyTerminal === 'valid';

const created = (facts: LaunchOutcomeFacts): boolean => completed(facts) && validReply(facts);

export const launchOutcomeDecision = (facts: LaunchOutcomeFacts): LaunchOutcome => {
  if (!facts.ran) {
    return 'refused';
  }

  return created(facts) ? 'created' : 'unknown';
};
