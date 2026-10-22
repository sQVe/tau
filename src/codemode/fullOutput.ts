import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// mkdtemp creates the directory readable only by its owner, outside the worktree under test.
export const saveFullOutput = async (prefix: string, text: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, 'output.log');

  await writeFile(path, text, { mode: 0o600 });

  return path;
};
