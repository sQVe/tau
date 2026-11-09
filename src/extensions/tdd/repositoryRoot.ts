export type RepositoryRoot = { kind: 'root'; path: string } | { kind: 'error'; message: string };

interface GitFacts {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// Reads `git rev-parse --show-toplevel`. Only a Git exit code says the directory is not in a
// checkout; a call without one failed, and falling back would resolve paths from the wrong root.
export const repositoryRootFrom = (cwd: string, git: GitFacts): RepositoryRoot => {
  const failure = `Tau could not find the Git checkout root of ${cwd}`;

  if (git.exitCode === null) {
    return { kind: 'error', message: `${failure}: ${git.stderr.trim()}` };
  }

  if (git.exitCode !== 0) {
    return { kind: 'root', path: cwd };
  }

  // A checkout path can end in spaces, so only Git's line terminator is removed.
  const root = git.stdout.replace(/\r?\n$/, '');

  if (root === '') {
    return {
      kind: 'error',
      message: `${failure}: git rev-parse --show-toplevel printed no path`,
    };
  }

  return { kind: 'root', path: root };
};
