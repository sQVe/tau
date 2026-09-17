import { join } from 'node:path';

import type { Loadout } from '../types.js';

export const fixtureLoadout = (directory: string): Loadout => ({
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
