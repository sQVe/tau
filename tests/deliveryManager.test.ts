import { expect, it } from 'vitest';

import { createManager, managerSession, otherSession } from './deliveryManager.js';

it('returns the branch entries of the current session', () => {
  const managerState = createManager();
  const entry = { type: 'custom', customType: 'tau-plan', data: { version: 1, steps: [] } };

  managerState.branchEntries.push(entry);

  expect(managerState.context.sessionManager.getBranch()).toEqual([entry]);

  managerState.switchSession(otherSession);

  expect(managerState.context.sessionManager.getBranch()).toEqual([]);

  managerState.switchSession(managerSession);

  expect(managerState.context.sessionManager.getBranch()).toEqual([entry]);
  expect(managerState.branchReads).toEqual([managerSession, otherSession, managerSession]);
});

it('includes the branch entries in the all-entry list', () => {
  const managerState = createManager();
  const sibling = { type: 'custom', customType: 'tau-plan', data: { version: 1, steps: [] } };
  const branch = { type: 'custom', customType: 'tau-plan', data: { version: 1, steps: [] } };

  managerState.entries.push(sibling);
  managerState.branchEntries.push(branch);

  expect(managerState.context.sessionManager.getEntries()).toEqual([sibling, branch]);
  expect(managerState.context.sessionManager.getBranch()).toEqual([branch]);
});
