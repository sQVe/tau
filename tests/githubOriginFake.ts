import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { vi } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

export const githubOrigin = 'git@github.com:sQVe/tau.git';

// Serves the origin's SSH transport from the local bare remote, so the origin keeps its GitHub URL.
// Git reads that URL with `remote get-url`, which an insteadOf rewrite would replace with a path.
// GIT_SSH_COMMAND overrides core.sshCommand, and the environment may set it to a real SSH wrapper,
// so the test replaces the variable for its duration. It also allows only the SSH protocol and drops
// inherited command-line config, so no URL rewrite can reach the real GitHub over another protocol.
export const serveGithubOriginFrom = async (
  remote: string,
  onTestFinished: (cleanup: () => void) => void,
): Promise<void> => {
  const shimDirectory = temporaryDirectory(onTestFinished, 'tau-pr-evidence-ssh-');
  const shim = join(shimDirectory, 'ssh');
  const serve = `exec git receive-pack '${remote}'`;
  const fetch = `exec git upload-pack '${remote}'`;

  await writeFile(
    shim,
    `#!/bin/sh\ncase "$*" in *git-receive-pack*) ${serve} ;; *) ${fetch} ;; esac\n`,
  );

  await chmod(shim, 0o755);

  vi.stubEnv('GIT_SSH_COMMAND', shim);
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'ssh');
  vi.stubEnv('GIT_CONFIG_COUNT', '0');
  vi.stubEnv('GIT_CONFIG_PARAMETERS', '');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
};
