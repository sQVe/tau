import { expect, it, vi } from 'vitest';

import { fakeStartProcessId, useFakeStartProcess } from '../../../../tests/startTicketFake.js';
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

it('keeps the claim and reports the cause when the adoption read fails', async ({
  onTestFinished,
}) => {
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const release = vi.fn<() => Promise<void>>();
  const readFailure = new Error('The lock could not be read.');

  const result = await releaseClaim(
    request({
      claim: { release },
      processId: fakeStartProcessId,
      childAdopted: () => Promise.reject(readFailure),
    }),
  );

  expect(result).toMatchObject({ kept: true, child: 'unknown' });
  expect(result.failure?.cause).toBe(readFailure);
  expect(release).not.toHaveBeenCalled();
  expect(processControl.signals).toEqual([]);
});

it('keeps the claim and reports the cause when releasing it fails', async () => {
  const release = vi.fn<() => Promise<void>>(() =>
    Promise.reject(new Error('The lock could not be written.')),
  );

  const result = await releaseClaim(
    request({
      claim: { release },
      ticket: 'notCreated',
      child: 'unknown',
    }),
  );

  expect(result).toMatchObject({ kept: true, child: 'unknown' });

  expect(result.failure?.message).toBe(
    'The claim could not be released: The lock could not be written.',
  );

  expect(result.failure?.cause).toMatchObject({ message: 'The lock could not be written.' });
  expect(release).toHaveBeenCalledTimes(1);
});

it('keeps the claim without a failure when the decision is keep', async () => {
  const release = vi.fn<() => Promise<void>>();

  const result = await releaseClaim(request({ claim: { release }, child: 'unknown' }));

  expect(result).toEqual({ kept: true, child: 'unknown' });
  expect(release).not.toHaveBeenCalled();
});

it('releases the claim after a stop that finds the child adopted', async ({ onTestFinished }) => {
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const release = vi.fn<() => Promise<void>>(() => Promise.resolve());

  const result = await releaseClaim(
    request({
      claim: { release },
      processId: fakeStartProcessId,
      childAdopted: () => Promise.resolve(true),
    }),
  );

  expect(result).toEqual({ kept: false, child: 'running' });
  expect(release).toHaveBeenCalledTimes(1);
  expect(processControl.signals).toEqual([]);
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
