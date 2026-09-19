import { join } from 'node:path';

import { claudeBuiltinTools, claudeChannelTools, claudeToolName } from '../claude.js';
import { isClaudeLoadout } from '../types.js';
import type { ClaudeLoadout, Loadout, PiLoadout } from '../types.js';

export const asPiLoadout = (loadout: Loadout): PiLoadout => {
  if (isClaudeLoadout(loadout)) {
    throw new Error('Expected a Pi worker loadout.');
  }

  return loadout;
};

export const fixtureClaudeLoadout = (directory: string): ClaudeLoadout => ({
  harness: 'claude',
  profile: 'claude-worker',
  role: 'editing',
  model: 'claude-tau-fixture',
  executable: join(directory, 'claude'),
  executableVersion: '2.1.276 (Claude Code)',
  thinking: 'low',
  cwd: directory,
  agentDirectory: join(directory, 'claude-config'),
  permissions: 'trusted-full-tools',
  permissionMode: 'bypassPermissions',
  safetyArguments: ['hook', '--coding-cli'],
  channelExecutable: process.execPath,
  channelScript: join(directory, 'claudeChannel.ts'),
  tools: [...claudeBuiltinTools, ...claudeChannelTools.map((tool) => claudeToolName(tool))],
  integrations: [join(directory, 'safety.js')],
  integrationFingerprint: '0'.repeat(64),
  safetyExtension: join(directory, 'safety.js'),
  instructions: 'Work on the assigned task.',
});

export const fixtureLoadout = (directory: string): PiLoadout => ({
  profile: 'worker',
  role: 'editing',
  model: 'faux/test',
  modelFingerprint: '0'.repeat(64),
  providerFingerprint: '0'.repeat(64),
  thinking: 'off',
  cwd: directory,
  agentDirectory: directory,
  permissions: 'trusted-full-tools',
  tools: ['read', 'bash', 'edit', 'write', 'subagent_report'],
  noExtensions: false,
  integrations: [join(directory, 'safety.js')],
  integrationFingerprint: '0'.repeat(64),
  safetyExtension: join(directory, 'safety.js'),
  instructions: 'Work on the assigned task.',
});
