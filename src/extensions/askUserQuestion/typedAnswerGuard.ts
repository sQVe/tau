export type BranchFact = { kind: 'askResult'; typed: boolean } | { kind: 'visibleText' };

export type GuardDecision = { kind: 'allow' } | { kind: 'refuse' };

// Facts run from oldest to newest. The newest fact decides: visible text answers a typed answer,
// and the latest ask result matters only when it holds typed text.
export const decideTypedAnswerReply = (facts: readonly BranchFact[]): GuardDecision => {
  const latest = facts.at(-1);

  if (latest?.kind === 'askResult' && latest.typed) {
    return { kind: 'refuse' };
  }

  return { kind: 'allow' };
};
