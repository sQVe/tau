import { onTestFinished, vi } from 'vitest';

import type { RoleKind } from '../src/role/role.js';
import tauRegistration from '../src/tau/tau.js';
import { fakeExtensionApi } from './extensionApi.js';
import type { FakeExtensionApi } from './extensionApi.js';

// Registers Tau for a role so a test can inspect what the entry point wires.
export const registeredTauApi = async (role: RoleKind): Promise<FakeExtensionApi> => {
  const roleVariable = role === 'lead' ? undefined : role;

  vi.stubEnv('TAU_ROLE', roleVariable);

  // A registered handler reads the role when the test invokes it, so the stub must outlive this
  // helper instead of being cleared before it returns.
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const fake = fakeExtensionApi();

  await tauRegistration(fake.pi);

  return fake;
};
