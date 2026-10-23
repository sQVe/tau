import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { runGit } from '../git.js';
import { appendSystemPrompt } from '../instructions/systemPrompt.js';

const rule =
  'This session runs in the bare repository root, not a worktree. Use it to read, answer ' +
  'questions, open worktrees, and hand off work. Do development in a worktree: open one with the ' +
  'worktree skill for new work, and pass work that belongs to an existing worktree on with the ' +
  'handover skill. Writing handover messages under .tau/handovers in the root is fine.';

const isBareRoot = async (cwd: string) => {
  const result = await runGit(cwd, ['rev-parse', '--is-bare-repository'], {
    timeoutMilliseconds: 5000,
  });

  return result.exitCode === 0 && result.stdout.toString('utf8').trim() === 'true';
};

export default function bareRootExtension(pi: ExtensionAPI): void {
  let bareRoot = false;

  pi.on('session_start', async (_event, context) => {
    bareRoot = await isBareRoot(context.cwd);
  });

  pi.on('before_agent_start', (event) => {
    if (bareRoot) {
      appendSystemPrompt(event, rule);
    }
  });
}
