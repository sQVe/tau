import { expect, it, vi } from 'vitest';

import { declinedExec } from '../../../tests/declinedExecFake.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';
import { startSweep } from './sweepStart.js';

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

it('returns the run outcome', async () => {
  const runSweep = vi.fn<SweepRunner>(async () => ({ outcome: 'caughtUp' }));

  await expect(
    startSweep({ cwd: '/work/me-1', agentDirectory: '/agent', exec: declinedExec }, runSweep),
  ).resolves.toEqual({ outcome: 'caughtUp' });

  expect(runSweep).toHaveBeenCalledTimes(1);
});

it('returns a failed outcome when the runner throws', async () => {
  const runSweep = vi.fn<SweepRunner>(async () => {
    throw new Error('gh failed');
  });

  await expect(
    startSweep({ cwd: '/work/me-1', agentDirectory: '/agent', exec: declinedExec }, runSweep),
  ).resolves.toEqual({ outcome: 'failed', reason: 'gh failed' });

  expect(runSweep).toHaveBeenCalledTimes(1);
});
