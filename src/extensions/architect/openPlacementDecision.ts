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

// A live lock holder means an architect runs. Its live recorded terminal is reused unless an ask
// runs there. Without a live holder no architect runs, even when the recorded terminal lives, so
// the architect starts beside the lead, or in a space of its own when the lead has no space.
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
