import { runGit } from '../../gitOutput.js';

// Resolves the trimmed output, or undefined when Git exits with 1.
export const readOptionalGit = async (
  cwd: string,
  commandArguments: string[],
): Promise<string | undefined> => {
  const result = await runGit(cwd, commandArguments);

  if (result.exitCode === 1) {
    return undefined;
  }

  if (result.exitCode !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout.toString('utf8').trim();
};

export const readGitBytes = async (cwd: string, commandArguments: string[]): Promise<Buffer> => {
  const result = await runGit(cwd, commandArguments);

  if (result.exitCode !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
};

export const readGit = async (cwd: string, commandArguments: string[]): Promise<string> => {
  const output = await readGitBytes(cwd, commandArguments);

  return output.toString('utf8').trim();
};
