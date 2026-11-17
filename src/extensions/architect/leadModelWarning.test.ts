import { expect, it } from 'vitest';

import { leadModelWarning } from './leadModelWarning.js';

it.each([
  {
    name: 'a lead on another model warns',
    facts: { role: 'lead', model: 'a/other', configured: 'a/lead' } as const,
    expected:
      'The lead runs on a/other, but roles.lead.model is a/lead. Start the lead on roles.lead.model to avoid model drift.',
  },
  {
    name: 'a lead on its configured model does not warn',
    facts: { role: 'lead', model: 'a/lead', configured: 'a/lead' } as const,
    expected: undefined,
  },
  {
    name: 'a lead without a configured model does not warn',
    facts: { role: 'lead', model: 'a/other', configured: undefined } as const,
    expected: undefined,
  },
  {
    name: 'an architect on another model does not warn',
    facts: { role: 'architect', model: 'a/other', configured: 'a/lead' } as const,
    expected: undefined,
  },
])('$name', ({ facts, expected }) => {
  expect(leadModelWarning(facts)).toBe(expected);
});
