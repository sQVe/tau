import { expect, it, vi } from 'vitest';

import tauRegistration from '../src/tau/tau.js';
import { blockedOutputReason, nohupClose } from './bashGuardCommands.js';
import { fakeExtensionApi } from './extensionApi.js';

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
      results.some(
        (result) =>
          result.status === 'fulfilled' && blockedOutputReason(result.value) !== undefined,
      ),
    ).toBe(true);
  },
);
