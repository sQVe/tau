import { expect, it } from 'vitest';

import { currentRole } from '../src/role/role.js';
import { registeredTauApi } from './tauRegistrationHarness.js';

it('keeps the requested role in the environment after registration', async () => {
  const fake = await registeredTauApi('worker');

  expect(fake.handlers.size).toBeGreaterThan(0);
  expect(currentRole()).toBe('worker');
});
