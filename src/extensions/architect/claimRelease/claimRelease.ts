import { kill, wait } from '../../../hc/hc.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { claimReleaseDecision } from './claimReleaseDecision.js';
import type { ClaimReleaseFacts } from './claimReleaseDecision.js';

export interface ClaimReleaseRequest {
  claim: { release: () => Promise<void> };
  launch: ClaimReleaseFacts['launch'];
  adopted: boolean;
  terminal: string | undefined;
  terminalState: ClaimReleaseFacts['terminal'];
  hc: HcRuntime;
}

const claimStopSeconds = 10;

const withoutSignal = (hc: HcRuntime): HcRuntime => ({ ...hc, signal: undefined });

// Releases the claim only when no Pi can still take it over. A live terminal is stopped and waited
// on first. An unknown or still-live terminal keeps the claim.
export const releaseClaim = async (request: ClaimReleaseRequest): Promise<boolean> => {
  const first = claimReleaseDecision({
    launch: request.launch,
    adopted: request.adopted,
    terminal: request.terminalState,
    stopAttempted: false,
  });

  if (first === 'release') {
    await request.claim.release();

    return false;
  }

  if (first === 'keep' || request.terminal === undefined) {
    return true;
  }

  const hc = withoutSignal(request.hc);

  await kill(hc, request.terminal).catch(() => undefined);

  const ended = await wait(hc, request.terminal, { timeout: claimStopSeconds }).then(
    (result) => result.ended,
    () => false,
  );

  const terminal = ended ? 'ended' : 'live';

  const second = claimReleaseDecision({
    launch: request.launch,
    adopted: request.adopted,
    terminal,
    stopAttempted: true,
  });

  if (second === 'release') {
    await request.claim.release();

    return false;
  }

  return true;
};
