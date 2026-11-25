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
});

it('keeps branch entries out of the all-entry list', () => {
  const managerState = createManager();

  managerState.branchEntries.push({ type: 'custom', customType: 'tau-plan' });

  expect(managerState.context.sessionManager.getEntries()).toEqual([]);
});
