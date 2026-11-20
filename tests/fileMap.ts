import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Writes each relative path and its content below a fixture directory.
export const writeFileMap = async (
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
};
