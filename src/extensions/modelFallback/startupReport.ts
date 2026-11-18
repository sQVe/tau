const startupReportKey = Symbol.for('tau.modelFallback.startupReported');

// Pi loads the factory once at process start and again on `/reload`, `/new`, `/resume`, and
// `/fork`. Those later loads keep the same `globalThis` while the module cache resets, so the key
// limits the stderr report to the first load in the process.
export const claimStartupReport = (store: Record<symbol, unknown> = globalThis): boolean => {
  if (Object.hasOwn(store, startupReportKey)) {
    return false;
  }

  store[startupReportKey] = true;

  return true;
};
