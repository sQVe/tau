import { isWriteWithinRoot } from './writeDecision.ts';

// A test process sets this root so a wrong project root or agent directory cannot write outside
// the test's temporary directory.
export const assertWriteWithinTestRoot = (path: string): void => {
  // oxlint-disable-next-line node/no-process-env -- The test runner sets the boundary for the test process.
  const root = process.env.TAU_TEST_WRITE_ROOT;

  if (isWriteWithinRoot(path, root)) {
    return;
  }

  throw new Error(`Refusing to write ${path} outside the test write root ${root}.`);
};
