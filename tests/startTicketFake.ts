import { execFile } from 'node:child_process';
import { rename } from 'node:fs/promises';
import { promisify } from 'node:util';

import { vi } from 'vitest';

interface StartTicketPaths {
  ticket: string;
  started: string;
}

export interface FakeStartProcess {
  state: 'running' | 'gone' | 'unknown';
  signals: NodeJS.Signals[];
  signalTimes: number[];
}

const wrapperName = 'tau-architect-start';
const run = promisify(execFile);

// A process id that no test process uses, so the real process probe reports it gone.
export const fakeStartProcessId = 999_999_999;

export const useFakeStartProcess = (
  cleanup: (cleanup: () => void) => void,
  initial: FakeStartProcess['state'] = 'gone',
  stopOnSignal = false,
): FakeStartProcess => {
  const control: FakeStartProcess = { state: initial, signals: [], signalTimes: [] };
  const original = process.kill.bind(process);

  const spy = vi.spyOn(process, 'kill').mockImplementation((processId, signal) => {
    if (processId !== fakeStartProcessId) {
      return original(processId, signal);
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

    if (stopOnSignal) {
      control.state = 'gone';
    }

    return true;
  });

  cleanup(() => {
    spy.mockRestore();
  });

  return control;
};

const startTicketOf = (argv: readonly string[]): StartTicketPaths | undefined => {
  const index = argv.indexOf(wrapperName);
  const ticket = argv[index + 1];

  if (index === -1 || ticket === undefined) {
    return undefined;
  }

  return { ticket, started: `${ticket}.started.${fakeStartProcessId}` };
};

// The child renames the ticket before it runs Pi. A fake launcher calls this to model that step.
export const takeStartTicket = async (argv: readonly string[]): Promise<boolean> => {
  const paths = startTicketOf(argv);

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
