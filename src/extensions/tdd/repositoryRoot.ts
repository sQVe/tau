export type RepositoryRoot = { kind: 'root'; path: string } | { kind: 'error'; message: string };

interface GitFacts {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// Git also exits 128 when it refuses a checkout, such as for dubious ownership. Tau runs Git with
// LC_ALL=C, so this message is stable.
const isOutsideCheckout = (git: GitFacts): boolean =>
  git.exitCode !== 0 && git.stderr.includes('not a git repository');

export const repositoryRootFrom = (cwd: string, git: GitFacts): RepositoryRoot => {
  const failure = `Tau could not find the Git checkout root of ${cwd}`;

  if (isOutsideCheckout(git)) {
    return { kind: 'root', path: cwd };
  }

  if (git.exitCode !== 0) {
    return { kind: 'error', message: `${failure}: ${git.stderr.trim()}` };
  }

  const root = git.stdout.replace(/\r?\n$/, '');

  if (root === '') {
    return {
      kind: 'error',
      message: `${failure}: git rev-parse --show-toplevel printed no path`,
    };
  }

  return { kind: 'root', path: root };
};
