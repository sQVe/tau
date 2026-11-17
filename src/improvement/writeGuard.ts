import { isWriteWithinRoot } from './writeDecision.ts';

export const assertWriteWithinTestRoot = (path: string): void => {
  // oxlint-disable-next-line node/no-process-env -- The test runner sets the boundary for the test process.
  const root = process.env.TAU_TEST_WRITE_ROOT;

  if (isWriteWithinRoot(path, root)) {
    return;
  }

  throw new Error(`Refusing to write ${path} outside the test write root ${root}.`);
};
