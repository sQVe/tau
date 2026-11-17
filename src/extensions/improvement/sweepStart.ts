import type { Exec } from '../../command.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';

interface SweepSession {
  cwd: string;
  agentDirectory: string;
  exec: Exec;
}

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

export const startSweep = async (session: SweepSession, run: SweepRunner): Promise<void> => {
  try {
    await run({
      agentDirectory: session.agentDirectory,
      cwd: session.cwd,
      exec: session.exec,
      now: () => new Date(),
      budgetMilliseconds: 20_000,
      since: '2026-04-09',
    });
  } catch {
    // A failed sweep must not interrupt the session.
  }
};
