import type { Exec } from '../../command.js';
import { errorMessage } from '../../errors.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';

interface SweepSession {
  cwd: string;
  agentDirectory: string;
  exec: Exec;
  signal: AbortSignal;
}

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

export interface SweepLifecycle {
  start: (session: Omit<SweepSession, 'signal'>, refresh: () => Promise<void>) => void;
  stop: () => Promise<void>;
  latest: () => SweepOutcome | undefined;
}

const startSweep = async (session: SweepSession, run: SweepRunner): Promise<SweepOutcome> => {
  try {
    return await run({
      agentDirectory: session.agentDirectory,
      cwd: session.cwd,
      exec: session.exec,
      now: () => new Date(),
      budgetMilliseconds: 20_000,
      since: '2026-04-09',
      signal: session.signal,
    });
  } catch (error) {
    return { outcome: 'failed', reason: errorMessage(error) };
  }
};

export const createSweepLifecycle = (run: SweepRunner): SweepLifecycle => {
  let current: { controller: AbortController; promise: Promise<void> } | undefined;
  let latest: SweepOutcome | undefined;

  const start: SweepLifecycle['start'] = (session, refresh) => {
    const controller = new AbortController();

    const promise = (async () => {
      const outcome = await startSweep({ ...session, signal: controller.signal }, run);

      if (controller.signal.aborted) {
        return;
      }

      latest = outcome;
      await refresh();
    })();

    current = { controller, promise };
  };

  const stop = async (): Promise<void> => {
    const running = current;

    if (running === undefined) {
      return;
    }

    running.controller.abort();
    await running.promise;
  };

  return { start, stop, latest: () => latest };
};
