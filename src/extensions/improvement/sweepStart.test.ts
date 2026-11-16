import { expect, it, vi } from 'vitest';

import { declinedExec } from '../../../tests/declinedExecFake.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';
import { startSweep } from './sweepStart.js';

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

it('drops a failing sweep', async () => {
  const runSweep = vi.fn<SweepRunner>(async () => {
    throw new Error('gh failed');
  });

  await expect(
    startSweep({ cwd: '/work/me-1', agentDirectory: '/agent', exec: declinedExec }, runSweep),
  ).resolves.toBeUndefined();

  expect(runSweep).toHaveBeenCalledTimes(1);
});
