import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isBareRoot } from '../git.js';
import { appendSystemPrompt } from '../instructions/systemPrompt.js';
import { isWorkerProcess } from '../role/role.js';

const bareRootRules = [
  'This session runs in the bare repository root, not a worktree. Use it to read, answer ' +
    'questions, open worktrees, and hand off work.',
  'Do development in a worktree: open one with the worktree skill for new work, and pass work ' +
    'that belongs to an existing worktree on with the handover skill.',
  'Writing handover messages under .tau/handovers in the root is fine.',
  "Before planning work for a worktree, read the selected worktree's AGENTS.md and its other " +
    'applicable rules.',
  'Plan against the default worktree only when no worktree has been selected.',
  'Read the applicable rules again when you switch worktrees.',
];

const rule = bareRootRules.map((policy) => `- ${policy}`).join('\n');

export default function bareRootExtension(pi: ExtensionAPI): void {
  let bareRoot = false;

  pi.on('session_start', async (_event, context) => {
    bareRoot = !isWorkerProcess() && (await isBareRoot(context.cwd));
  });

  pi.on('before_agent_start', (event) => {
    if (bareRoot) {
      appendSystemPrompt(event, rule);
    }
  });
}
