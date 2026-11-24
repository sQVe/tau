import { failureWithRelease } from '../../../errors.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { processState } from '../../../process/process.js';
import type { ProcessState } from '../../../process/process.js';
import { releaseClaim } from '../claimRelease/claimRelease.js';
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
import {
  startFenceCancellable,
  startFenceMarkerToDelete,
  startFenceTicketFact,
} from './startFenceDecision.js';
import type { StartFencePhase } from './startFenceDecision.js';

export type StartFenceBlocker =
  | { kind: 'starting' }
  | { kind: 'runningProcess'; processId: number }
  | { kind: 'malformedMarker'; path: string };

export type StartFenceAcquisition =
  | { kind: 'refused' }
  | { kind: 'blocked'; blocker: StartFenceBlocker }
  | { kind: 'acquired'; fence: StartFence };

interface StartFenceAbandonment {
  adopted: boolean;
}

interface StartFenceFinishRequest {
  adopted: boolean;
  stopAttempted: boolean;
}

interface StartFenceFinish {
  kept: boolean;
  failure?: Error;
}

export interface StartFence {
  token: string;
  createTicket: () => Promise<void>;
  wrapArgv: (argv: string[]) => string[];
  recordStarted: () => Promise<void>;
  childProcessId: () => number | undefined;
  childAdopted: () => Promise<boolean>;
  refreshChild: () => Promise<ProcessState>;
  abandon: () => Promise<StartFenceAbandonment>;
  finish: (request: StartFenceFinishRequest) => Promise<StartFenceFinish>;
}

interface FenceState {
  phase: StartFencePhase;
  ticketPath: string | undefined;
  leadPid: number;
  childPid: number | undefined;
  child: ProcessState;
  adoptedSeen: boolean;
  // Memoizes the one release so a caller that settles twice reports the same result.
  finished: StartFenceFinish | undefined;
}

// The caller's own fallback names its start path, so only the blockers with one message live here.
export const startFenceBlockerMessage = (blocker: StartFenceBlocker): string | undefined => {
  if (blocker.kind === 'runningProcess') {
    return startHeldByProcessReason(blocker.processId);
  }

  return blocker.kind === 'malformedMarker' ? malformedStartMarkerReason(blocker.path) : undefined;
};

const childOf = (processId: number | undefined): ProcessState =>
  processId === undefined ? 'unknown' : processState(processId);

const takenPhase = (processId: number | undefined): StartFencePhase =>
  processId === undefined ? 'takenWithoutProcess' : 'started';

const blockerOf = (sweep: Exclude<StartSweepResult, { kind: 'clear' }>): StartFenceBlocker => {
  if (sweep.kind === 'starting') {
    return { kind: 'starting' };
  }

  return sweep.kind === 'refuseRunning'
    ? { kind: 'runningProcess', processId: sweep.processId }
    : { kind: 'malformedMarker', path: sweep.path };
};

const startFence = (
  root: string,
  claim: { release: () => Promise<void>; token: string },
  leadPid: number,
): StartFence => {
  const state: FenceState = {
    phase: 'noTicket',
    ticketPath: undefined,
    leadPid,
    childPid: undefined,
    child: 'unknown',
    adoptedSeen: false,
    finished: undefined,
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

  const createTicket = async (): Promise<void> => {
    state.ticketPath = await createStartTicket(root, claim.token, state.leadPid);
    state.phase = 'active';
  };

  const wrapArgv = (argv: string[]): string[] => wrapStartArgv(currentTicketPath(), argv);

  const recordStarted = async (): Promise<void> => {
    await readOwnMarker();
    state.phase = takenPhase(state.childPid);
  };

  const childProcessId = (): number | undefined => state.childPid;

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

  const abandon = async (): Promise<StartFenceAbandonment> => {
    if (state.finished !== undefined || !startFenceCancellable(state.phase)) {
      return { adopted: state.adoptedSeen };
    }

    const cancelled = await cancelStartTicket(currentTicketPath());

    if (cancelled === 'cancelled') {
      state.phase = 'cancelled';

      return { adopted: state.adoptedSeen };
    }

    if (cancelled === 'unread') {
      state.phase = 'unread';

      return { adopted: state.adoptedSeen };
    }

    await readOwnMarker();
    state.phase = takenPhase(state.childPid);

    return { adopted: await childAdopted() };
  };

  const finish = async (request: StartFenceFinishRequest): Promise<StartFenceFinish> => {
    if (state.finished !== undefined) {
      return state.finished;
    }

    const ticket = startFenceTicketFact(state.phase);
    const adopted = request.adopted || (await childAdopted());

    const released = await releaseClaim({
      claim,
      ticket,
      adopted,
      child: state.child,
      processId: state.childPid,
      childAdopted,
      stopAttempted: request.stopAttempted,
    });

    state.child = released.child;

    const markerProcess = startFenceMarkerToDelete({
      kept: released.kept,
      ticket,
      child: released.child,
      processId: state.childPid,
    });

    if (markerProcess !== undefined) {
      await deleteStartMarker(root, claim.token, state.leadPid, markerProcess).catch(
        // A marker left by a child the kernel reports gone is swept by the next start.
        () => undefined,
      );
    }

    const finished: StartFenceFinish = {
      kept: released.kept,
      ...(released.failure === undefined ? {} : { failure: released.failure }),
    };

    state.finished = finished;

    return finished;
  };

  const refreshChild = async (): Promise<ProcessState> => {
    await readOwnMarker();

    return state.child;
  };

  return {
    token: claim.token,
    createTicket,
    wrapArgv,
    recordStarted,
    childProcessId,
    childAdopted,
    refreshChild,
    abandon,
    finish,
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
