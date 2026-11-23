interface OpenLockHolder {
  pid: number;
  checkout: string;
  token: string;
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

export interface OpenRecordFacts {
  terminal: string | null | undefined;
  token: string | undefined;
}

export interface OpenGenerationFacts {
  root: string;
  holder: OpenLockHolder;
  record: OpenRecordFacts;
}

export type OpenGeneration =
  | { kind: 'current'; terminal: string | null | undefined }
  | { kind: 'refuse'; checkout: string }
  | { kind: 'unrecorded' };

const isSameHolder = (first: OpenLockHolder, second: OpenLockHolder): boolean =>
  first.pid === second.pid && first.checkout === second.checkout && first.token === second.token;

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
  const { holder, record, root } = facts;

  if (record.token === undefined || record.token === holder.token) {
    return { kind: 'current', terminal: record.terminal };
  }

  if (holder.checkout !== root) {
    return { kind: 'refuse', checkout: holder.checkout };
  }

  return { kind: 'unrecorded' };
};
