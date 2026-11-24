import { expect, it, vi } from 'vitest';

import { releaseClaim } from './claimRelease.js';
import type { ClaimReleaseRequest } from './claimRelease.js';

const request = (overrides: Partial<ClaimReleaseRequest>): ClaimReleaseRequest => ({
  claim: { release: () => Promise.resolve() },
  ticket: 'taken',
  adopted: false,
  child: 'running',
  processId: undefined,
  childAdopted: () => Promise.resolve(false),
  ...overrides,
});

it('keeps the claim and returns a decision when the adoption read fails', async () => {
  const release = vi.fn<() => Promise<void>>();

  const result = await releaseClaim(
    request({
      claim: { release },
      processId: process.pid,
      childAdopted: () => Promise.reject(new Error('The lock could not be read.')),
    }),
  );

  expect(result).toEqual({ kept: true, child: 'unknown' });
  expect(release).not.toHaveBeenCalled();
});

it('keeps the claim and returns a decision when releasing it fails', async () => {
  const result = await releaseClaim(
    request({
      claim: { release: () => Promise.reject(new Error('The lock could not be written.')) },
      ticket: 'notCreated',
      child: 'unknown',
    }),
  );

  expect(result).toEqual({ kept: true, child: 'unknown' });
});

it('reports the released claim with the child it stopped', async () => {
  const release = vi.fn<() => Promise<void>>(() => Promise.resolve());

  const result = await releaseClaim(
    request({
      claim: { release },
      ticket: 'notCreated',
      child: 'gone',
    }),
  );

  expect(result).toEqual({ kept: false, child: 'gone' });
  expect(release).toHaveBeenCalledTimes(1);
});
