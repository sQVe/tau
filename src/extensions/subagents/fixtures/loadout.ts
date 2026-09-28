import type { Loadout } from '../types.js';

export const fixtureLoadout = (directory: string): Loadout => ({
  harness: 'pi',
  profile: 'worker',
  role: 'editing',
  model: 'faux/test',
  thinking: 'off',
  cwd: directory,
  agentDirectory: directory,
  permissions: 'trusted-full-tools',
  instructions: 'Work on the assigned task.',
});
