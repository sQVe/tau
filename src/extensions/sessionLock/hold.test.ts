import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { holdSessionLock, switchRefusal } from './hold.js';

const isolatedAgentDirectory = (onTestFinished: TestContext['onTestFinished']): string => {
  const directory = temporaryDirectory(onTestFinished, 'tau-session-lock-hold-');
  const agentDirectory = join(directory, 'agent');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  return agentDirectory;
};

it('takes no lock for a session with no file', async ({ onTestFinished }) => {
  const agentDirectory = isolatedAgentDirectory(onTestFinished);

  await expect(holdSessionLock(undefined, '/checkout')).resolves.toEqual({ kind: 'none' });
  expect(existsSync(join(agentDirectory, 'tau'))).toBe(false);
});

it('does not refuse a resume onto the session file this process holds', async ({
  onTestFinished,
}) => {
  const agentDirectory = isolatedAgentDirectory(onTestFinished);
  const sessionFile = join(agentDirectory, 'session.jsonl');
  const held = await holdSessionLock(sessionFile, '/checkout');

  onTestFinished(async () => {
    if (held.kind === 'held') {
      await held.release();
    }
  });

  expect(held.kind).toBe('held');
  await expect(switchRefusal(sessionFile)).resolves.toBeUndefined();
});
