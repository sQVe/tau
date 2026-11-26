import { expect, it } from 'vitest';

import { createManager, managerSession, otherSession, planEntry } from './deliveryManager.js';

it('returns the branch entries of the current session', () => {
  const managerState = createManager();
  const entry = planEntry([]);

  managerState.pushBranchEntry(entry);

  expect(managerState.context.sessionManager.getBranch()).toEqual([entry]);

  managerState.switchSession(otherSession);

  expect(managerState.context.sessionManager.getBranch()).toEqual([]);

  managerState.switchSession(managerSession);

  expect(managerState.context.sessionManager.getBranch()).toEqual([entry]);
  expect(managerState.branchReads).toEqual([managerSession, otherSession, managerSession]);
});

it('includes the branch entries in the all-entry list', () => {
  const managerState = createManager();
  const sibling = planEntry([{ text: 'Sibling step', status: 'pending' }]);
  const branch = planEntry([]);

  managerState.pushEntry(sibling);
  managerState.pushBranchEntry(branch);

  expect(managerState.context.sessionManager.getEntries()).toEqual([sibling, branch]);
  expect(managerState.context.sessionManager.getBranch()).toEqual([branch]);
});

it('keeps a branch entry before a later sibling entry in the all-entry list', () => {
  const managerState = createManager();
  const branch = planEntry([]);
  const sibling = planEntry([{ text: 'Sibling step', status: 'pending' }]);

  managerState.pushBranchEntry(branch);
  managerState.pushEntry(sibling);

  expect(managerState.context.sessionManager.getEntries()).toEqual([branch, sibling]);
  expect(managerState.context.sessionManager.getBranch()).toEqual([branch]);
});
