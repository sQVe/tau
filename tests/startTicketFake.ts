import { execFile } from 'node:child_process';
import { rename } from 'node:fs/promises';
import { promisify } from 'node:util';

import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type { HcFake } from './hcFake.js';

interface StartTicketPaths {
  ticket: string;
  started: string;
}

export interface FakeStartProcess {
  state: 'running' | 'gone' | 'unknown';
  signals: NodeJS.Signals[];
  signalTimes: number[];
  nextSignal: (count: number) => Promise<void>;
}

interface FakeStartProcessControl extends FakeStartProcess {
  stopOnSignal: boolean;
  signalWaiters: { count: number; resolve: () => void }[];
}

interface FakeStartProcesses {
  spy: MockInstance<typeof process.kill>;
  states: Map<number, FakeStartProcessControl>;
}

const wrapperName = 'tau-architect-start';
const run = promisify(execFile);

// A process id that no test process uses, so the real process probe reports it gone.
export const fakeStartProcessId = 999_999_999;
// A second unused process id for a launched child whose fake state stays running.
export const fakeRunningStartProcessId = 999_999_998;

// Vitest returns the existing mock from a second spyOn, so one spy serves every fake process and
// keeps the native probe for the processes it does not know.
let fakeProcesses: FakeStartProcesses | undefined;

const installFakeProcesses = (): FakeStartProcesses => {
  const nativeKill = process.kill.bind(process);
  const states = new Map<number, FakeStartProcessControl>();

  const spy = vi.spyOn(process, 'kill').mockImplementation((killedProcessId, signal) => {
    const control = states.get(killedProcessId);

    if (control === undefined) {
      return nativeKill(killedProcessId, signal);
    }

    if (signal === 0) {
      if (control.state === 'gone') {
        throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      }

      if (control.state === 'unknown') {
        throw Object.assign(new Error('Unknown process state'), { code: 'EINVAL' });
      }

      return true;
    }

    control.signals.push(signal as NodeJS.Signals);
    control.signalTimes.push(Date.now());

    if (control.stopOnSignal) {
      control.state = 'gone';
    }

    control.signalWaiters = control.signalWaiters.filter((waiter) => {
      if (control.signals.length < waiter.count) {
        return true;
      }

      waiter.resolve();

      return false;
    });

    return true;
  });

  return { spy, states };
};

// A signal that never arrives must fail its assertion before the runner's own test timeout.
const signalTimeoutMilliseconds = 2_000;

const waitForSignal = (control: FakeStartProcessControl, count: number): Promise<void> => {
  if (control.signals.length >= count) {
    return Promise.resolve();
  }

  const timeout = AbortSignal.timeout(signalTimeoutMilliseconds);

  return new Promise((resolve, reject) => {
    const waiter: { count: number; resolve: () => void } = { count, resolve: () => undefined };

    const onTimeout = (): void => {
      control.signalWaiters = control.signalWaiters.filter((pending) => pending !== waiter);

      reject(
        new Error(
          `The fake start process received ${control.signals.length} signals, but the test waited for ${count}.`,
        ),
      );
    };

    waiter.resolve = (): void => {
      timeout.removeEventListener('abort', onTimeout);
      resolve();
    };

    control.signalWaiters.push(waiter);

    timeout.addEventListener('abort', onTimeout, { once: true });
  });
};

export const useFakeStartProcess = (
  cleanup: (cleanup: () => void) => void,
  initial: FakeStartProcess['state'] = 'gone',
  stopOnSignal = false,
  processId: number = fakeStartProcessId,
): FakeStartProcess => {
  fakeProcesses ??= installFakeProcesses();

  const control: FakeStartProcessControl = {
    state: initial,
    signals: [],
    signalTimes: [],
    stopOnSignal,
    signalWaiters: [],
    nextSignal: (count) => waitForSignal(control, count),
  };

  fakeProcesses.states.set(processId, control);

  cleanup(() => {
    if (fakeProcesses === undefined) {
      return;
    }

    fakeProcesses.states.delete(processId);

    if (fakeProcesses.states.size === 0) {
      fakeProcesses.spy.mockRestore();
      fakeProcesses = undefined;
    }
  });

  return control;
};

const startTicketOf = (
  argv: readonly string[],
  processId: number,
): StartTicketPaths | undefined => {
  const index = argv.indexOf(wrapperName);

  if (index === -1) {
    return undefined;
  }

  const ticket = argv[index + 1];

  if (ticket === undefined) {
    return undefined;
  }

  return { ticket, started: `${ticket}.started.${processId}` };
};

// The child renames the ticket before it runs Pi. A fake launcher calls this to model that step.
export const takeStartTicket = async (
  argv: readonly string[],
  processId: number = fakeStartProcessId,
): Promise<boolean> => {
  const paths = startTicketOf(argv, processId);

  if (paths === undefined) {
    return false;
  }

  try {
    await rename(paths.ticket, paths.started);

    return true;
  } catch {
    return false;
  }
};

// Wraps a fake hc so a successful run takes the ticket, as the real child does.
export const takingStartTicket = (hc: HcFake): HcFake => ({
  ...hc,
  exec: async (command, commandArguments, options) => {
    const result = await hc.exec(command, commandArguments, options);

    if (command === 'hc' && commandArguments[0] === 'run' && result.code === 0) {
      await takeStartTicket(commandArguments);
    }

    return result;
  },
});

export const runLaunchArgv = async (argv: readonly string[], cwd: string): Promise<number> => {
  const [command, ...commandArguments] = argv;

  if (command === undefined) {
    return -1;
  }

  try {
    await run(command, commandArguments, { cwd });

    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
};
