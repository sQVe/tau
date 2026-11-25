import { expect, it, vi } from 'vitest';

import tauRegistration from '../src/tau/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

const nohupClose =
  'nohup sh -c \'sleep 30; herdr-app do space.close --id sp527dd22aa065042833adf82c857c6cab --confirmed\' >/dev/null 2>&1 & echo "close scheduled"';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const blocksDetachedOutput = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  const reason = value['reason'];

  return (
    value['block'] === true && typeof reason === 'string' && reason.includes('/tmp/<name>.log')
  );
};

it.each(['lead', 'architect', 'worker'] as const)(
  'registers the detached output guard for the %s role',
  async (role) => {
    const roleVariable = role === 'lead' ? undefined : role;

    vi.stubEnv('TAU_ROLE', roleVariable);

    const fake = fakeExtensionApi();

    try {
      await tauRegistration(fake.pi);
    } finally {
      vi.unstubAllEnvs();
    }

    const event = { toolName: 'bash', input: { command: nohupClose } };

    const results = await Promise.allSettled(
      (fake.handlers.get('tool_call') ?? []).map(async (handler) =>
        handler(event as never, {} as never),
      ),
    );

    expect(
      results.some((result) => result.status === 'fulfilled' && blocksDetachedOutput(result.value)),
    ).toBe(true);
  },
);
