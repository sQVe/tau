import { expect, it } from 'vitest';

import { holdFileLock, readLiveLockHolder } from './fileLock.js';
import type { HeldFileLock } from './fileLock.js';
import { fixture } from './fixtures/fileLockHarness.js';

const checkout = '/checkout';

const release = async (held: HeldFileLock): Promise<void> => {
  if (held.kind === 'held') {
    await held.release();
  }
};

const claim = async (lockPath: string): Promise<HeldFileLock> =>
  holdFileLock({ lockPath, checkout, terminal: undefined, token: 'claim' });

it('refuses a plain hold while a live claim holds the lock', async ({ onTestFinished }) => {
  const { lockPath } = fixture();
  const held = await claim(lockPath);

  onTestFinished(async () => {
    await release(held);
  });

  const plain = await holdFileLock({ lockPath, checkout, terminal: 't2' });

  expect(plain).toMatchObject({ kind: 'refused', holder: { token: 'claim', terminal: undefined } });
});

it('admits the holder whose token names the claim', async ({ onTestFinished }) => {
  const { lockPath } = fixture();
  const held = await claim(lockPath);

  onTestFinished(async () => {
    await release(held);
  });

  const adopter = await holdFileLock({
    lockPath,
    checkout,
    terminal: 't-pi',
    token: 'pi',
    adopt: 'claim',
  });

  onTestFinished(async () => {
    await release(adopter);
  });

  expect(adopter.kind).toBe('held');
  expect(await readLiveLockHolder(lockPath)).toMatchObject({ token: 'pi', terminal: 't-pi' });
});

it('refuses a holder whose token does not name the claim', async ({ onTestFinished }) => {
  const { lockPath } = fixture();
  const held = await claim(lockPath);

  onTestFinished(async () => {
    await release(held);
  });

  const other = await holdFileLock({
    lockPath,
    checkout,
    terminal: undefined,
    token: 'pi',
    adopt: 'other',
  });

  expect(other).toMatchObject({ kind: 'refused', holder: { token: 'claim' } });
});

it('leaves the new holder live when the claim releases after the takeover', async ({
  onTestFinished,
}) => {
  const { lockPath } = fixture();
  const held = await claim(lockPath);

  onTestFinished(async () => {
    await release(held);
  });

  const adopter = await holdFileLock({
    lockPath,
    checkout,
    terminal: 't-pi',
    token: 'pi',
    adopt: 'claim',
  });

  onTestFinished(async () => {
    await release(adopter);
  });

  await release(held);

  expect(await readLiveLockHolder(lockPath)).toMatchObject({ token: 'pi' });
});
