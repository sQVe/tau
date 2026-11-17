import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertWriteWithinTestRoot } from './writeGuard.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertWriteWithinTestRoot', () => {
  it.each([
    { name: 'no test root', root: undefined, target: '/tmp/outside/event.json', allowed: true },
    { name: 'an empty test root', root: '', target: '/tmp/outside/event.json', allowed: true },
    {
      name: 'a target inside the test root',
      root: '/tmp/tau-root',
      target: '/tmp/tau-root/event.json',
      allowed: true,
    },
    {
      name: 'a target outside the test root',
      root: '/tmp/tau-root',
      target: '/tmp/tau-other/event.json',
      allowed: false,
    },
  ])('$name', ({ root, target, allowed }) => {
    vi.stubEnv('TAU_TEST_WRITE_ROOT', root);

    const outcome = (() => {
      try {
        assertWriteWithinTestRoot(target);

        return 'allowed';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();

    const expected = allowed
      ? 'allowed'
      : `Refusing to write ${target} outside the test write root ${root}.`;

    expect(outcome).toBe(expected);
  });
});
