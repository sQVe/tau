import { stopStartedChild } from '../startTicket/stopStartedChild.js';
import { claimReleaseDecision } from './claimReleaseDecision.js';
import type { ClaimReleaseFacts } from './claimReleaseDecision.js';

export interface ClaimReleaseRequest {
  claim: { release: () => Promise<void> };
  ticket: ClaimReleaseFacts['ticket'];
  adopted: boolean;
  child: ClaimReleaseFacts['child'];
  processId: number | undefined;
  childAdopted: () => Promise<boolean>;
  stopAttempted?: boolean;
}

export interface ClaimReleaseResult {
  kept: boolean;
  child: ClaimReleaseFacts['child'];
}

// Releases the claim when the ticket was never taken, the child is gone, or the child adopted.
// A running or unknown child keeps the claim and the marker.
export const releaseClaim = async (request: ClaimReleaseRequest): Promise<ClaimReleaseResult> => {
  const decide = (child: ClaimReleaseFacts['child'], stopAttempted: boolean, adopted: boolean) =>
    claimReleaseDecision({
      ticket: request.ticket,
      adopted,
      child,
      stopAttempted,
    });

  const release = async (child: ClaimReleaseFacts['child']): Promise<ClaimReleaseResult> => {
    const released = await request.claim.release().then(
      () => true,
      () => false,
    );

    return released ? { kept: false, child } : { kept: true, child };
  };

  let adopted = request.adopted;
  const first = decide(request.child, request.stopAttempted ?? false, adopted);

  if (first === 'release') {
    return release(request.child);
  }

  if (first === 'keep') {
    return { kept: true, child: request.child };
  }

  const child =
    request.processId === undefined
      ? 'unknown'
      : await stopStartedChild(request.processId, {
          adopted: async () => {
            if (!adopted) {
              adopted = await request.childAdopted();
            }

            return adopted;
          },
        }).catch(() => 'unknown' as const);

  const second = decide(child, true, adopted);

  if (second === 'release') {
    return release(child);
  }

  return { kept: true, child };
};
