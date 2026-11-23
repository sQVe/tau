interface OpenLockHolder {
  pid: number;
  checkout: string;
}

interface EligibilityFacts {
  liveTerminal: string | undefined;
  terminalRunsAsk: boolean;
  terminalLabeledAsk: boolean;
}

export interface OpenCandidateFacts extends EligibilityFacts {
  holder: OpenLockHolder;
  terminalHasPane: boolean;
}

export type OpenCandidate =
  | { kind: 'candidate'; terminal: string }
  | { kind: 'parked'; message: string }
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

export interface OpenGenerationFacts {
  root: string;
  holder: { checkout: string; token: string };
  recordToken: string | undefined;
}

export type OpenGeneration =
  | { kind: 'current' }
  | { kind: 'refuse'; checkout: string }
  | { kind: 'unrecorded'; message: string };

const isSameHolder = (first: OpenLockHolder, second: OpenLockHolder): boolean =>
  first.pid === second.pid && first.checkout === second.checkout;

export const eligibleTerminal = (facts: EligibilityFacts): string | undefined => {
  const isAskTerminal = facts.terminalRunsAsk || facts.terminalLabeledAsk;

  return isAskTerminal ? undefined : facts.liveTerminal;
};

export const openCandidate = (facts: OpenCandidateFacts): OpenCandidate => {
  const liveTerminal = eligibleTerminal(facts);

  if (liveTerminal === undefined) {
    return { kind: 'refuse', checkout: facts.holder.checkout };
  }

  if (!facts.terminalHasPane) {
    return {
      kind: 'parked',
      message: `The architect terminal ${liveTerminal} is parked: it still runs but has no pane. Give it a pane with herdr-app do terminal.keep --terminal ${liveTerminal}, then call architect open again.`,
    };
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

// A saved record ties its terminal to the lock generation that wrote it. A record from another
// generation names a terminal that is not the live holder's terminal.
export const openGeneration = (facts: OpenGenerationFacts): OpenGeneration => {
  const { holder, recordToken, root } = facts;

  if (recordToken === undefined || recordToken === holder.token) {
    return { kind: 'current' };
  }

  if (holder.checkout !== root) {
    return { kind: 'refuse', checkout: holder.checkout };
  }

  return {
    kind: 'unrecorded',
    message: `The architect in ${root} has not recorded its terminal yet. Call architect open again shortly.`,
  };
};
