import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { groupStateFromTable, stateFromProbe } from './stateDecision.js';
import type { ProcessState } from './stateDecision.js';

export type { ProcessState } from './stateDecision.js';

const groupPollMilliseconds = 20;

const probe = (processId: number): ProcessState => {
  try {
    process.kill(processId, 0);

    return stateFromProbe(undefined);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';

    return stateFromProbe(code);
  }
};

export const processState = (processId: number): ProcessState => probe(processId);

const readProcessTable = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pgid=,stat=']);

    return stdout;
  } catch {
    return undefined;
  }
};

export const groupState = async (groupId: number): Promise<ProcessState> => {
  if (process.platform === 'win32') {
    return processState(groupId);
  }

  const probed = probe(-groupId);

  if (probed !== 'running') {
    return probed;
  }

  return groupStateFromTable(await readProcessTable(), groupId);
};

export const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    if (process.platform === 'win32' || child.pid === undefined) {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
};

export const stopGroup = async (child: ChildProcess, graceMilliseconds: number): Promise<void> => {
  const { pid } = child;

  if (pid === undefined) {
    return;
  }

  signalGroup(child, 'SIGTERM');

  const deadline = Date.now() + graceMilliseconds;
  let killed = false;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
    const state = await groupState(pid);

    const unreadableAfterKill = killed && state === 'unknown';

    if (state === 'gone' || unreadableAfterKill) {
      return;
    }

    if (!killed && Date.now() >= deadline) {
      killed = true;
      signalGroup(child, 'SIGKILL');
    }

    // oxlint-disable-next-line no-await-in-loop -- Each poll depends on the previous one.
    await sleep(groupPollMilliseconds);
  }
};
