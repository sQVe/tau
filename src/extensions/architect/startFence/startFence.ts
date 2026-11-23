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
  readStartMarker,
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
  takenOver: boolean;
}

interface StartFenceFinishRequest {
  adopted: boolean;
  stopAttempted: boolean;
}

interface StartFenceFinish {
  kept: boolean;
}

export interface StartFence {
  token: string;
  createTicket: () => Promise<void>;
  wrapArgv: (argv: string[]) => string[];
  recordStarted: () => Promise<void>;
  refreshChild: () => ProcessState;
  abandon: () => Promise<StartFenceAbandonment>;
  finish: (request: StartFenceFinishRequest) => Promise<StartFenceFinish>;
}

interface FenceState {
  phase: StartFencePhase;
  ticketPath: string | undefined;
  processId: number | undefined;
  child: ProcessState;
  takenOver: boolean;
  // Memoizes the one release so a caller that settles twice reports the same result.
  finished: StartFenceFinish | undefined;
}

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
): StartFence => {
  const state: FenceState = {
    phase: 'noTicket',
    ticketPath: undefined,
    processId: undefined,
    child: 'unknown',
    takenOver: false,
    finished: undefined,
  };

  const currentTicketPath = (): string => {
    if (state.ticketPath === undefined) {
      throw new Error('The start fence has no ticket.');
    }

    return state.ticketPath;
  };

  const claimTakenOver = async (): Promise<boolean> => {
    const holder = await readLiveLockHolder(architectLockPath(root));

    return holder !== undefined && holder.token !== claim.token;
  };

  const createTicket = async (): Promise<void> => {
    state.ticketPath = await createStartTicket(root, claim.token);
    state.phase = 'active';
  };

  const wrapArgv = (argv: string[]): string[] => wrapStartArgv(currentTicketPath(), argv);

  const recordStarted = async (): Promise<void> => {
    const marker = await readStartMarker(root, claim.token);
    const processId = marker?.kind === 'process' ? marker.pid : undefined;

    state.processId = processId;
    state.child = childOf(processId);
    state.phase = takenPhase(processId);
  };

  const abandon = async (): Promise<StartFenceAbandonment> => {
    if (state.finished !== undefined || !startFenceCancellable(state.phase)) {
      return { takenOver: state.takenOver };
    }

    const cancelled = await cancelStartTicket(currentTicketPath());

    if (cancelled === 'cancelled') {
      state.phase = 'cancelled';

      return { takenOver: state.takenOver };
    }

    if (cancelled === 'unread') {
      state.phase = 'unread';

      return { takenOver: state.takenOver };
    }

    state.phase = takenPhase(state.processId);

    if (state.processId === undefined) {
      await recordStarted();
    }

    if (!state.takenOver) {
      state.takenOver = await claimTakenOver();
    }

    if (state.takenOver) {
      state.child = 'running';
    }

    return { takenOver: state.takenOver };
  };

  const finish = async (request: StartFenceFinishRequest): Promise<StartFenceFinish> => {
    if (state.finished !== undefined) {
      return state.finished;
    }

    const ticket = startFenceTicketFact(state.phase);

    const released = await releaseClaim({
      claim,
      ticket,
      adopted: request.adopted,
      child: state.child,
      processId: state.processId,
      stopAttempted: request.stopAttempted,
    });

    state.child = released.child;

    const markerProcess = startFenceMarkerToDelete({
      kept: released.kept,
      ticket,
      child: released.child,
      processId: state.processId,
    });

    if (markerProcess !== undefined) {
      await deleteStartMarker(root, claim.token, markerProcess).catch(() => undefined);
    }

    const finished: StartFenceFinish = { kept: released.kept };

    state.finished = finished;

    return finished;
  };

  const refreshChild = (): ProcessState => {
    state.child = childOf(state.processId);

    return state.child;
  };

  return {
    token: claim.token,
    createTicket,
    wrapArgv,
    recordStarted,
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
): Promise<StartFenceAcquisition> => {
  const claim = await claimArchitectLock(root, claimOptions);

  if (claim.kind === 'refused') {
    return { kind: 'refused' };
  }

  let sweep: StartSweepResult;

  try {
    sweep = await sweepStartFolder({ root, currentToken: claim.token });
  } catch (error) {
    await claim.release();

    throw error;
  }

  if (sweep.kind !== 'clear') {
    await claim.release();

    return { kind: 'blocked', blocker: blockerOf(sweep) };
  }

  return { kind: 'acquired', fence: startFence(root, claim) };
};
