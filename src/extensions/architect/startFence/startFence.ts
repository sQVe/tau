import { setTimeout as sleep } from 'node:timers/promises';

import { errorMessage, failureWithRelease } from '../../../errors.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { processState } from '../../../process/process.js';
import type { ProcessState } from '../../../process/process.js';
import { claimReleaseDecision } from '../claimRelease/claimReleaseDecision.js';
import { architectLockPath, claimArchitectLock } from '../lock.js';
import type { ArchitectClaimOptions } from '../lock.js';
import {
  cancelStartTicket,
  createStartTicket,
  deleteStartMarker,
  malformedStartMarkerReason,
  readStartMarker,
  startHeldByProcessReason,
  sweepStartFolder,
  wrapStartArgv,
} from '../startTicket/startTicket.js';
import type { StartSweepResult } from '../startTicket/startTicket.js';
import { stopStartedChild } from '../startTicket/stopStartedChild.js';
import { startFenceCompletionDecision, startFenceTakeoverDecision } from './startFenceDecision.js';
import type {
  StartFenceOutcome,
  StartFenceTakeover,
  StartFenceTicketFact,
} from './startFenceDecision.js';

export type StartFenceBlocker =
  | { kind: 'starting' }
  | { kind: 'runningProcess'; processId: number }
  | { kind: 'malformedMarker'; path: string };

export type StartFenceAcquisition =
  | { kind: 'refused' }
  | { kind: 'blocked'; blocker: StartFenceBlocker }
  | { kind: 'acquired'; fence: StartFence };

export interface StartFenceCompletion {
  outcome: StartFenceOutcome;
  claim: 'released' | 'kept';
  failure?: Error;
}

export interface StartFence {
  token: string;
  createTicket: () => Promise<void>;
  wrapArgv: (argv: string[]) => string[];
  recordStarted: () => Promise<void>;
  childProcessId: () => number | undefined;
  waitForTakeover: (deadline: number, signal?: AbortSignal) => Promise<StartFenceTakeover>;
  complete: () => Promise<StartFenceCompletion>;
}

interface FenceState {
  ticketPath: string | undefined;
  leadPid: number;
  childPid: number | undefined;
  child: ProcessState;
  adoptedSeen: boolean;
  completion: StartFenceCompletion | undefined;
}

interface TicketCancel {
  ticket: StartFenceTicketFact;
  failure?: Error;
}

const takeoverPollMilliseconds = 250;

// The caller's own fallback names its start path, so only the blockers with one message live here.
export const startFenceBlockerMessage = (blocker: StartFenceBlocker): string | undefined => {
  if (blocker.kind === 'runningProcess') {
    return startHeldByProcessReason(blocker.processId);
  }

  return blocker.kind === 'malformedMarker' ? malformedStartMarkerReason(blocker.path) : undefined;
};

const childOf = (processId: number | undefined): ProcessState =>
  processId === undefined ? 'unknown' : processState(processId);

const blockerOf = (sweep: Exclude<StartSweepResult, { kind: 'clear' }>): StartFenceBlocker => {
  if (sweep.kind === 'starting') {
    return { kind: 'starting' };
  }

  return sweep.kind === 'refuseRunning'
    ? { kind: 'runningProcess', processId: sweep.processId }
    : { kind: 'malformedMarker', path: sweep.path };
};

const contextualFailure =
  (label: string) =>
  (error: unknown): Error =>
    new Error(`${label}: ${errorMessage(error)}`, { cause: error });

const releaseFailure = contextualFailure('The claim could not be released');
const adoptionReadFailure = contextualFailure('The child adoption could not be read');

const signalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const startFence = (
  root: string,
  claim: { release: () => Promise<void>; token: string },
  leadPid: number,
): StartFence => {
  const state: FenceState = {
    ticketPath: undefined,
    leadPid,
    childPid: undefined,
    child: 'unknown',
    adoptedSeen: false,
    completion: undefined,
  };

  const currentTicketPath = (): string => {
    if (state.ticketPath === undefined) {
      throw new Error('The start fence has no ticket.');
    }

    return state.ticketPath;
  };

  const readOwnMarker = async (): Promise<void> => {
    const marker = await readStartMarker(root, claim.token, state.leadPid);
    const usable = marker !== undefined && marker.kind !== 'malformed';

    if (usable) {
      state.childPid ??= marker.childPid;

      if (marker.kind === 'adopted') {
        state.adoptedSeen = true;
      }
    }

    state.child = childOf(state.childPid);
  };

  const childAdopted = async (): Promise<boolean> => {
    await readOwnMarker();

    if (state.adoptedSeen) {
      return true;
    }

    if (state.childPid === undefined) {
      return false;
    }

    const holder = await readLiveLockHolder(architectLockPath(root));

    // The adopting child mints its own lock token, so its pid is the only link back to this child.
    const adopted = holder !== undefined && holder.pid === state.childPid;

    if (adopted) {
      state.adoptedSeen = true;
    }

    return adopted;
  };

  const createTicket = async (): Promise<void> => {
    state.ticketPath = await createStartTicket(root, claim.token, state.leadPid);
  };

  const wrapArgv = (argv: string[]): string[] => wrapStartArgv(currentTicketPath(), argv);

  const recordStarted = async (): Promise<void> => {
    await readOwnMarker();
  };

  const childProcessId = (): number | undefined => state.childPid;

  const cancelTicket = async (): Promise<TicketCancel> => {
    if (state.ticketPath === undefined) {
      return { ticket: 'notCreated' };
    }

    const cancelled = await cancelStartTicket(state.ticketPath);

    if (cancelled !== 'taken') {
      return { ticket: cancelled };
    }

    try {
      await readOwnMarker();

      return { ticket: 'taken' };
    } catch (error) {
      return { ticket: 'taken', failure: adoptionReadFailure(error) };
    }
  };

  const stopTakenChild = async (ticket: StartFenceTicketFact): Promise<Error | undefined> => {
    const action = claimReleaseDecision({
      ticket,
      adopted: state.adoptedSeen,
      child: state.child,
      stopAttempted: false,
    });

    if (action !== 'stop' || state.childPid === undefined) {
      return undefined;
    }

    try {
      state.child = await stopStartedChild(state.childPid, { adopted: childAdopted });

      return undefined;
    } catch (error) {
      state.child = 'unknown';

      return adoptionReadFailure(error);
    }
  };

  const refreshChildFacts = async (): Promise<void> => {
    // The cancellation's read failure is the one reported, so a failed retry can only leave the
    // child unknown.
    await readOwnMarker().catch(() => undefined);
  };

  const readCompletionFacts = async (): Promise<Error | undefined> => {
    try {
      await childAdopted();

      return undefined;
    } catch (error) {
      return adoptionReadFailure(error);
    }
  };

  const releaseOwnClaim = async (): Promise<Error | undefined> => {
    try {
      await claim.release();

      return undefined;
    } catch (error) {
      return releaseFailure(error);
    }
  };

  const deleteOwnMarker = async (): Promise<void> => {
    if (state.childPid === undefined) {
      return;
    }

    await deleteStartMarker(root, claim.token, state.leadPid, state.childPid).catch(
      // A marker left by a child the kernel reports gone is swept by the next start.
      () => undefined,
    );
  };

  const complete = async (): Promise<StartFenceCompletion> => {
    if (state.completion !== undefined) {
      return state.completion;
    }

    const cancelled = await cancelTicket();

    if (cancelled.failure !== undefined) {
      await refreshChildFacts();
    }

    const stopFailure = await stopTakenChild(cancelled.ticket);
    const readFailure = await readCompletionFacts();

    const plan = startFenceCompletionDecision({
      ticket: cancelled.ticket,
      child: state.child,
      adopted: state.adoptedSeen,
      processId: state.childPid,
    });

    const released = plan.claim === 'release';
    const releaseError = released ? await releaseOwnClaim() : undefined;
    const claimReleased = released && releaseError === undefined;

    if (plan.marker === 'delete' && claimReleased) {
      await deleteOwnMarker();
    }

    const failure = releaseError ?? cancelled.failure ?? stopFailure ?? readFailure;

    const completion: StartFenceCompletion = {
      outcome: plan.outcome,
      claim: claimReleased ? 'released' : 'kept',
      ...(failure === undefined ? {} : { failure }),
    };

    state.completion = completion;

    return completion;
  };

  const takeoverPoll = async (signal: AbortSignal | undefined): Promise<void> => {
    const sleepOptions = signal === undefined ? {} : { signal };

    try {
      await sleep(takeoverPollMilliseconds, undefined, sleepOptions);
    } catch (error) {
      if (signalAborted(signal)) {
        return;
      }

      throw error;
    }
  };

  const waitForTakeover = async (
    deadline: number,
    signal?: AbortSignal,
  ): Promise<StartFenceTakeover> => {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
      const adopted = await childAdopted();

      const progress = startFenceTakeoverDecision({
        adopted,
        gone: state.childPid !== undefined && state.child === 'gone',
        now: Date.now(),
        deadline,
        cancelled: signalAborted(signal),
      });

      if (progress !== 'waiting') {
        return progress;
      }

      // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
      await takeoverPoll(signal);
    }
  };

  return {
    token: claim.token,
    createTicket,
    wrapArgv,
    recordStarted,
    childProcessId,
    waitForTakeover,
    complete,
  };
};

// Takes the claim and sweeps the start folder. A blocked start releases the claim before the
// caller reports it.
export const acquireStartFence = async (
  root: string,
  claimOptions: ArchitectClaimOptions = {},
  leadPid: number = process.pid,
): Promise<StartFenceAcquisition> => {
  const claim = await claimArchitectLock(root, claimOptions);

  if (claim.kind === 'refused') {
    return { kind: 'refused' };
  }

  let sweep: StartSweepResult;

  try {
    sweep = await sweepStartFolder({ root, currentToken: claim.token });
  } catch (error) {
    throw await failureWithRelease(error, claim.release, {
      failure: 'The start sweep failed',
      release: 'releasing the claim failed',
    });
  }

  if (sweep.kind !== 'clear') {
    await claim.release();

    return { kind: 'blocked', blocker: blockerOf(sweep) };
  }

  return { kind: 'acquired', fence: startFence(root, claim, leadPid) };
};
