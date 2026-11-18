export interface OpenPlacementFacts {
  holder: { checkout: string } | undefined;
  liveTerminal: string | undefined;
  terminalRunsAsk: boolean;
  leadSpace: string | undefined;
}

export type OpenPlacement =
  | { kind: 'reuse'; terminal: string }
  | { kind: 'refuse'; checkout: string }
  | { kind: 'pane' }
  | { kind: 'newSpace' };

export const openPlacement = (facts: OpenPlacementFacts): OpenPlacement => {
  if (facts.holder !== undefined) {
    const { liveTerminal } = facts;

    if (liveTerminal !== undefined && !facts.terminalRunsAsk) {
      return { kind: 'reuse', terminal: liveTerminal };
    }

    return { kind: 'refuse', checkout: facts.holder.checkout };
  }

  const hasLeadSpace = facts.leadSpace !== undefined && facts.leadSpace !== '';

  return { kind: hasLeadSpace ? 'pane' : 'newSpace' };
};
