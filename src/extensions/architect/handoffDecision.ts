export interface StartClaimFacts {
  claimToken: string | undefined;
  handoffRoot: string | undefined;
  root: string;
}

export type StartClaim =
  | { kind: 'hold' }
  | { kind: 'adopt'; token: string }
  | { kind: 'leave'; previousRoot: string; token: string };

// A claim without a handoff root is a lead's claim, which the next start always adopts.
export const startClaim = ({ claimToken, handoffRoot, root }: StartClaimFacts): StartClaim => {
  if (claimToken === undefined) {
    return { kind: 'hold' };
  }

  if (handoffRoot === undefined || handoffRoot === root) {
    return { kind: 'adopt', token: claimToken };
  }

  return { kind: 'leave', previousRoot: handoffRoot, token: claimToken };
};
