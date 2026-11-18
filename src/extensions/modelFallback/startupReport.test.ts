import { expect, it } from 'vitest';

import { claimStartupReport } from './startupReport.js';

it('claims the startup report once per store', () => {
  const store: Record<symbol, unknown> = {};

  expect(claimStartupReport(store)).toBe(true);
  expect(claimStartupReport(store)).toBe(false);
  expect(claimStartupReport({})).toBe(true);
});
