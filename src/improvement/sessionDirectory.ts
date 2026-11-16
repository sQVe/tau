import { join, resolve } from 'node:path';

export const sessionDirectoryFor = (worktree: string, agentDirectory: string): string => {
  const resolvedWorktree = resolve(worktree);
  const resolvedAgentDirectory = resolve(agentDirectory);
  const folder = `--${resolvedWorktree.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

  return join(resolvedAgentDirectory, 'sessions', folder);
};
