import { expect, it } from 'vitest';

import { currentRole } from '../src/role/role.js';
import { registeredTauApi } from './tauRegistrationHarness.js';

it('keeps the requested role in the environment after registration', async () => {
  await registeredTauApi('worker');

  expect(currentRole()).toBe('worker');
});
