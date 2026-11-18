import { expect, it } from 'vitest';

import type { RoleKind } from './role.js';
import { roleRegistersTool } from './roleTools.js';

const cases: readonly {
  case: string;
  role: RoleKind;
  tool: string;
  expected: boolean;
}[] = [
  {
    case: 'the lead registers the architect tool',
    role: 'lead',
    tool: 'architect',
    expected: true,
  },
  {
    case: 'the architect does not register the architect tool',
    role: 'architect',
    tool: 'architect',
    expected: false,
  },
  {
    case: 'a worker does not register the architect tool',
    role: 'worker',
    tool: 'architect',
    expected: false,
  },
  {
    case: 'a tool outside the table is registered',
    role: 'architect',
    tool: 'slice',
    expected: true,
  },
  {
    case: 'inherited names are registered',
    role: 'lead',
    tool: 'constructor',
    expected: true,
  },
];

it.each(cases)('decides whether $case', ({ role, tool, expected }) => {
  expect(roleRegistersTool(role, tool)).toBe(expected);
});
