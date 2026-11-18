interface OpenLockHolder {
  pid: number;
  checkout: string;
}

export interface OpenCandidateFacts {
  holder: OpenLockHolder;
  liveTerminal: string | undefined;
  terminalRunsAsk: boolean;
  terminalLabeledAsk: boolean;
}

export type OpenCandidate =
  | { kind: 'candidate'; terminal: string }
  | { kind: 'refuse'; checkout: string };

export interface OpenReuseFacts {
  holder: OpenLockHolder;
  currentHolder: OpenLockHolder | undefined;
  terminal: string;
}

export type OpenReuse =
  | { kind: 'reuse'; terminal: string }
  | { kind: 'refuse'; checkout: string }
  | { kind: 'start' };

const isSameHolder = (first: OpenLockHolder, second: OpenLockHolder): boolean =>
  first.pid === second.pid && first.checkout === second.checkout;

export const openCandidate = (facts: OpenCandidateFacts): OpenCandidate => {
  const { liveTerminal } = facts;
  const isAskTerminal = facts.terminalRunsAsk || facts.terminalLabeledAsk;

  if (liveTerminal === undefined || isAskTerminal) {
    return { kind: 'refuse', checkout: facts.holder.checkout };
  }

  return { kind: 'candidate', terminal: liveTerminal };
};

export const openReuse = (facts: OpenReuseFacts): OpenReuse => {
  const { holder, currentHolder, terminal } = facts;

  if (currentHolder === undefined) {
    return { kind: 'start' };
  }

  if (!isSameHolder(holder, currentHolder)) {
    return { kind: 'refuse', checkout: currentHolder.checkout };
  }

  return { kind: 'reuse', terminal };
};
