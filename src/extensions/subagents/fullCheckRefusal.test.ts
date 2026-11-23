import { expect, it } from 'vitest';

import { fullCheckRefusal } from './fullCheckRefusal.js';

const declaration = { owner: 'AI-1688', reason: 'the module is not wired in yet' };

it.each([
  {
    name: 'editing accepts a declaration with a configured check',
    role: 'editing' as const,
    fullCheck: declaration,
    configured: true,
    refused: false,
  },
  {
    name: 'investigation refuses a declaration',
    role: 'investigation' as const,
    fullCheck: declaration,
    configured: true,
    refused: true,
  },
  {
    name: 'an absent declaration is accepted',
    role: 'investigation' as const,
    fullCheck: undefined,
    configured: false,
    refused: false,
  },
  {
    name: 'a blank owner is refused',
    role: 'editing' as const,
    fullCheck: { ...declaration, owner: '  ' },
    configured: true,
    refused: true,
  },
  {
    name: 'a blank reason is refused',
    role: 'editing' as const,
    fullCheck: { ...declaration, reason: '' },
    configured: true,
    refused: true,
  },
  {
    name: 'a declaration without a configured check is refused',
    role: 'editing' as const,
    fullCheck: declaration,
    configured: false,
    refused: true,
  },
])('$name', ({ role, fullCheck, configured, refused }) => {
  expect(fullCheckRefusal(role, fullCheck, configured) !== undefined).toBe(refused);
});
