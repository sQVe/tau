import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const rule =
  'This session runs in the bare repository root, not a worktree. Use it to read, answer ' +
  'questions, open worktrees, and hand off work. Do development in a worktree: open one with the ' +
  'worktree skill for new work, and pass work that belongs to an existing worktree on with the ' +
  'handoff skill. Writing handoff messages under .tau/handoffs in the root is fine.';

const isBareRoot = async (cwd: string) => {
  // oxlint-disable-next-line node/no-process-env -- An inherited repository selector would make Git check that repository instead of cwd.
  const inherited = process.env;

  const {
    GIT_DIR: _gitDir,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_COMMON_DIR: _gitCommonDir,
    ...env
  } = inherited;

  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--is-bare-repository'], {
      cwd,
      env,
    });

    return stdout.trim() === 'true';
  } catch {
    return false;
  }
};

export default function bareRootExtension(pi: ExtensionAPI) {
  let bareRoot = false;

  pi.on('session_start', async (_event, context) => {
    bareRoot = await isBareRoot(context.cwd);
  });

  pi.on('before_agent_start', (event) =>
    bareRoot ? { systemPrompt: `${event.systemPrompt}\n\n${rule}` } : undefined,
  );
}
