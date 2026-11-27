import { expect, it } from 'vitest';

import { registeredTauApi } from './tauRegistration.js';

it('registers the plan tool through the Tau registration for the lead', async () => {
  const fake = await registeredTauApi('lead');

  expect(fake.tools.get('plan')?.name).toBe('plan');
});

it.each(['architect', 'worker'] as const)(
  'registers no plan tool through the Tau registration for the %s',
  async (role) => {
    const fake = await registeredTauApi(role);

    expect(fake.tools.has('plan')).toBe(false);
  },
);
