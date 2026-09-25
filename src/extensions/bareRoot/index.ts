import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const rule =
  'This session runs in the bare repository root, not a worktree. Read and answer questions here, ' +
  'but do not edit files, run tests, commit, or launch workers. For new work, open a worktree with ' +
  'the worktree skill. For work that belongs to an existing worktree, pass it on with the handoff ' +
  'skill.';

const blockedTools = new Set(['write', 'edit', 'subagent', 'subagent_follow_up']);

const isBareRoot = async (cwd: string) => {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--is-bare-repository'], {
      cwd,
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

  pi.on('tool_call', (event) =>
    bareRoot && blockedTools.has(event.toolName) ? { block: true, reason: rule } : undefined,
  );
}
