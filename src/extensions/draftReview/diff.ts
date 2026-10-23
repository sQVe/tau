import { runGit } from '../../git.js';

const hunkStart = /^@@ /m;

// `git diff --no-index` exits 1 when the files differ. The header names temporary files, so the
// result starts at the first hunk and gets a header with the reviewed path.
export const diffFiles = async (
  original: string,
  staged: string,
  path: string,
): Promise<string> => {
  const result = await runGit(process.cwd(), [
    'diff',
    '--no-index',
    '--no-color',
    '--',
    original,
    staged,
  ]);

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git diff --no-index failed: ${result.stderr.trim()}`);
  }

  const output = result.stdout.toString('utf8');
  const start = output.search(hunkStart);
  const hunks = start === -1 ? '' : output.slice(start);

  return `--- a/${path}\n+++ b/${path}\n${hunks}`;
};
