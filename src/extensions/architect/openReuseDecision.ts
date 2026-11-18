export interface OpenReuseFacts {
  checkout: string;
  liveTerminal: string | undefined;
  terminalRunsAsk: boolean;
  terminalLabeledAsk: boolean;
}

export type OpenReuse = { kind: 'reuse'; terminal: string } | { kind: 'refuse'; checkout: string };

export const openReuse = (facts: OpenReuseFacts): OpenReuse => {
  const { liveTerminal } = facts;
  const isAskTerminal = facts.terminalRunsAsk || facts.terminalLabeledAsk;

  if (liveTerminal !== undefined && !isAskTerminal) {
    return { kind: 'reuse', terminal: liveTerminal };
  }

  return { kind: 'refuse', checkout: facts.checkout };
};
