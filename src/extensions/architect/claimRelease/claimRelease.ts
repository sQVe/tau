import { errorMessage } from '../../../errors.js';
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
  // The failure that kept the claim, so the caller reports it instead of an ordinary held claim.
  failure?: Error;
}

interface StoppedChild {
  child: ClaimReleaseFacts['child'];
  failure?: Error;
}

const contextualFailure =
  (label: string) =>
  (error: unknown): Error =>
    new Error(`${label}: ${errorMessage(error)}`, { cause: error });

const releaseFailure = contextualFailure('The claim could not be released');
const stopFailure = contextualFailure('The child adoption could not be read');

const stopChild = async (
  request: ClaimReleaseRequest,
  adopted: () => Promise<boolean>,
): Promise<StoppedChild> => {
  if (request.processId === undefined) {
    return { child: 'unknown' };
  }

  try {
    return { child: await stopStartedChild(request.processId, { adopted }) };
  } catch (error) {
    return { child: 'unknown', failure: stopFailure(error) };
  }
};

const keptClaim = (stopped: StoppedChild): ClaimReleaseResult => {
  if (stopped.failure === undefined) {
    return { kept: true, child: stopped.child };
  }

  return { kept: true, child: stopped.child, failure: stopped.failure };
};

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
    try {
      await request.claim.release();

      return { kept: false, child };
    } catch (error) {
      return { kept: true, child, failure: releaseFailure(error) };
    }
  };

  let adopted = request.adopted;
  const first = decide(request.child, request.stopAttempted ?? false, adopted);

  if (first === 'release') {
    return release(request.child);
  }

  if (first === 'keep') {
    return { kept: true, child: request.child };
  }

  const stopped = await stopChild(request, async () => {
    if (!adopted) {
      adopted = await request.childAdopted();
    }

    return adopted;
  });

  const second = decide(stopped.child, true, adopted);

  if (second === 'release') {
    return release(stopped.child);
  }

  return keptClaim(stopped);
};
