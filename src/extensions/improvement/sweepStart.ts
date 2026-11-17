import type { Exec } from '../../command.js';
import { errorMessage } from '../../errors.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';

interface SweepSession {
  cwd: string;
  agentDirectory: string;
  exec: Exec;
}

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

export const startSweep = async (
  session: SweepSession,
  run: SweepRunner,
): Promise<SweepOutcome> => {
  try {
    return await run({
      agentDirectory: session.agentDirectory,
      cwd: session.cwd,
      exec: session.exec,
      now: () => new Date(),
      budgetMilliseconds: 20_000,
      since: '2026-04-09',
    });
  } catch (error) {
    return { outcome: 'failed', reason: errorMessage(error) };
  }
};
