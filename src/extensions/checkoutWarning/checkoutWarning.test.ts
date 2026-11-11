import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import checkoutWarningExtension from './checkoutWarning.js';

const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.stubEnv('TAU_ROLE', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const repository = async (commitsBehind: number) => {
  const checkout = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
  await git(checkout, 'commit', '--allow-empty', '-m', 'initial');
  await git(checkout, 'checkout', '-b', 'upstream');

  for (let index = 0; index < commitsBehind; index++) {
    await git(checkout, 'commit', '--allow-empty', '-m', `upstream ${index}`);
  }

  await git(checkout, 'checkout', 'main');
  await git(checkout, 'branch', '--set-upstream-to=upstream');

  return checkout;
};

const startSession = async (checkout: string) => {
  const api = fakeExtensionApi();
  const notify = vi.fn<ExtensionContext['ui']['notify']>();
  checkoutWarningExtension(api.pi, checkout);
  const context = { cwd: '/not-the-tau-checkout', ui: { notify } } as unknown as ExtensionContext;
  await api.handler('session_start')({ type: 'session_start', reason: 'startup' }, context);

  return notify;
};

describe('checkout warning', () => {
  it('warns once when two commits behind without changing the checkout', async () => {
    const checkout = await repository(2);
    const head = await git(checkout, 'rev-parse', 'HEAD');
    const refs = await git(checkout, 'show-ref');
    const status = await git(checkout, 'status', '--porcelain');

    const notify = await startSession(checkout);

    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('2 commits'), 'warning');

    expect(notify.mock.calls[0]?.[0]).toContain(
      `git -C ${checkout} pull --ff-only && pnpm -C ${checkout} install`,
    );

    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(checkout, 'show-ref')).toBe(refs);
    expect(await git(checkout, 'status', '--porcelain')).toBe(status);
  });

  it('stays silent when equal to upstream', async () => {
    const checkout = await repository(0);

    expect(await startSession(checkout)).not.toHaveBeenCalled();
  });

  it('stays silent without an upstream', async () => {
    const checkout = await repository(0);
    await git(checkout, 'branch', '--unset-upstream');

    expect(await startSession(checkout)).not.toHaveBeenCalled();
  });

  it('stays silent in worker processes', async () => {
    const checkout = await repository(2);
    vi.stubEnv('TAU_ROLE', 'worker');

    expect(await startSession(checkout)).not.toHaveBeenCalled();
  });
});
