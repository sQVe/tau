import { expect, it } from 'vitest';

import { fullCheckRefusal } from './fullCheckRefusal.js';

const declaration = { owner: 'AI-1688', reason: 'the module is not wired in yet' };

const editingOnly = 'fullCheck applies only to editing workers';

it.each([
  {
    name: 'editing accepts a declaration with a configured check',
    role: 'editing' as const,
    fullCheck: declaration,
    configured: true,
  },
  {
    name: 'an absent declaration is accepted',
    role: 'investigation' as const,
    fullCheck: undefined,
    configured: false,
  },
])('$name', ({ role, fullCheck, configured }) => {
  expect(fullCheckRefusal(role, fullCheck, configured)).toBeUndefined();
});

it.each([
  {
    name: 'investigation refuses a declaration',
    role: 'investigation' as const,
    fullCheck: declaration,
    configured: true,
    message: editingOnly,
  },
  {
    name: 'an editing declaration with a blank owner names the owner field',
    role: 'editing' as const,
    fullCheck: { ...declaration, owner: '  ' },
    configured: true,
    message: 'fullCheck.owner must not be blank.',
  },
  {
    name: 'an editing declaration with a blank reason names the reason field',
    role: 'editing' as const,
    fullCheck: { ...declaration, reason: '' },
    configured: true,
    message: 'fullCheck.reason must not be blank.',
  },
  {
    name: 'an investigation declaration with a blank owner gets the editing-only refusal',
    role: 'investigation' as const,
    fullCheck: { ...declaration, owner: '  ' },
    configured: true,
    message: editingOnly,
  },
  {
    name: 'an investigation declaration with a blank reason gets the editing-only refusal',
    role: 'investigation' as const,
    fullCheck: { ...declaration, reason: '' },
    configured: true,
    message: editingOnly,
  },
  {
    name: 'a declaration without a configured check is refused',
    role: 'editing' as const,
    fullCheck: declaration,
    configured: false,
    message: 'fullCheck requires a configured full check command',
  },
])('$name', ({ role, fullCheck, configured, message }) => {
  expect(fullCheckRefusal(role, fullCheck, configured)).toContain(message);
});
