import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const temporaryDirectory = (
  onTestFinished: (cleanup: () => void) => void,
  prefix: string,
): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return directory;
};
