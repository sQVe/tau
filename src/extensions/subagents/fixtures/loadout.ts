import { join } from 'node:path';

import { readTask } from '../records.js';
import { isPiLoadout, requireNativeTask } from '../types.js';
import type { GenericLoadout, Loadout, PiLoadout, Task } from '../types.js';

export const asPiLoadout = (loadout: Loadout): PiLoadout => {
  if (!isPiLoadout(loadout)) {
    throw new Error('Expected a Pi worker loadout.');
  }

  return loadout;
};

const asPiTask = (task: Task) => ({
  ...requireNativeTask(task),
  loadout: asPiLoadout(task.loadout),
});
export const readPiTask = (directory: string) => asPiTask(readTask(directory));

export const fixtureGenericLoadout = (directory: string, kind = 'codex'): GenericLoadout => ({
  harness: 'generic',
  kind,
  profile: 'worker',
  role: 'editing',
  cwd: directory,
  permissions: 'native-controls',
  arguments: [],
  reportDirectory: directory,
  instructions: 'Only the assigned task.',
});

export const fixtureLoadout = (directory: string): PiLoadout => ({
  harness: 'pi',
  profile: 'worker',
  role: 'editing',
  model: 'faux/test',
  modelFingerprint: '0'.repeat(64),
  providerFingerprint: '0'.repeat(64),
  providerFingerprintVersion: 2,
  thinking: 'off',
  cwd: directory,
  agentDirectory: directory,
  permissions: 'trusted-full-tools',
  tools: [
    'read',
    'bash',
    'edit',
    'write',
    'subagent_progress',
    'subagent_report',
    'subagent_question',
  ],
  noExtensions: false,
  integrations: [join(directory, 'safety.js')],
  integrationFingerprint: '0'.repeat(64),
  safetyExtension: join(directory, 'safety.js'),
  instructions: 'Work on the assigned task.',
});
