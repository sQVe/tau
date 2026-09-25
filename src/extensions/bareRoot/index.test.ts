import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import {
  createTemporaryBareRoot,
  createTemporaryRepository,
} from '../../../tests/gitRepository.js';
import bareRootExtension from './index.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const startSession = async (cwd: string) => {
  const api = fakeExtensionApi();
  bareRootExtension(api.pi);
  const context = { cwd } as ExtensionContext;
  await api.handler('session_start')({ type: 'session_start', reason: 'startup' }, context);

  const systemPrompt = (
    api.handler('before_agent_start')({ systemPrompt: 'base' }, context) as
      | { systemPrompt: string }
      | undefined
  )?.systemPrompt;

  return { systemPrompt, refusesTools: api.handlers.has('tool_call') };
};

describe('bare repository root guard', () => {
  it('points the agent to worktrees and handoffs in a bare root without refusing tools', async () => {
    const root = await createTemporaryBareRoot((cleanup) => cleanups.push(cleanup));
    const session = await startSession(root);

    expect(session.systemPrompt).toMatch(
      /^base\n\n.*worktree skill.*handoff skill.*\.tau\/handoffs/s,
    );

    expect(session.refusesTools).toBe(false);
  });

  it.for(['GIT_DIR', 'GIT_COMMON_DIR'])(
    'checks the session directory even when Pi inherits %s for another repository',
    async (variable) => {
      const root = await createTemporaryBareRoot((cleanup) => cleanups.push(cleanup));
      const other = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
      vi.stubEnv(variable, join(other, '.git'));
      const session = await startSession(root);

      expect(session.systemPrompt).toMatch(/worktree skill/);
    },
  );

  it('leaves sessions in a worktree of a bare repository alone', async () => {
    const root = await createTemporaryBareRoot((cleanup) => cleanups.push(cleanup));

    await promisify(execFile)('git', ['worktree', 'add', '--quiet', '--orphan', 'main'], {
      cwd: root,
    });

    const session = await startSession(join(root, 'main'));

    expect(session.systemPrompt).toBeUndefined();
  });
});
