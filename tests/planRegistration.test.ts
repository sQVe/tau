import { afterEach, expect, it, vi } from 'vitest';

import tauRegistration from '../src/tau/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

const register = async (role: 'lead' | 'architect' | 'worker') => {
  const roleVariable = role === 'lead' ? undefined : role;
  vi.stubEnv('TAU_ROLE', roleVariable);
  const fake = fakeExtensionApi();

  try {
    await tauRegistration(fake.pi);
  } finally {
    vi.unstubAllEnvs();
  }

  return fake;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

it('registers the plan tool through the Tau registration for the lead', async () => {
  const fake = await register('lead');

  expect(fake.tools.get('plan')?.name).toBe('plan');
});

it.each(['architect', 'worker'] as const)(
  'registers no plan tool through the Tau registration for the %s',
  async (role) => {
    const fake = await register(role);

    expect(fake.tools.has('plan')).toBe(false);
  },
);
