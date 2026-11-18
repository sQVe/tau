import { expect, it } from 'vitest';

import { roleLaunchRefusal } from './roleLaunchRefusal.js';

it.each([
  { launchingRole: 'architect', role: 'editing', refused: true },
  { launchingRole: 'architect', role: 'investigation', refused: false },
  { launchingRole: 'lead', role: 'editing', refused: false },
  { launchingRole: 'lead', role: 'investigation', refused: false },
  { launchingRole: 'worker', role: 'editing', refused: false },
] as const)(
  '$launchingRole launching $role refused: $refused',
  ({ launchingRole, role, refused }) => {
    const refusal = roleLaunchRefusal(launchingRole, { profile: 'implementer', role });
    const namesProfile = refusal?.includes('implementer') ?? false;

    expect(refusal !== undefined).toBe(refused);
    expect(namesProfile).toBe(refused);
  },
);
