import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryBareRoot } from '../../../tests/gitRepository.js';
import bareRootExtension from './index.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
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

  const callTool = (toolName: string) =>
    api.handler('tool_call')(
      { type: 'tool_call', toolCallId: 'call-1', toolName, input: {} },
      context,
    ) as { block: boolean; reason: string } | undefined;

  return { systemPrompt, callTool };
};

describe('bare repository root guard', () => {
  it('tells the agent to use a worktree and blocks edits and workers in a bare root', async () => {
    const root = await createTemporaryBareRoot((cleanup) => cleanups.push(cleanup));
    const session = await startSession(root);

    expect(session.systemPrompt).toMatch(/^base\n\n.*worktree skill.*handoff skill/s);

    for (const toolName of ['write', 'edit', 'subagent', 'subagent_follow_up']) {
      expect(session.callTool(toolName)).toMatchObject({
        block: true,
        reason: expect.stringMatching(/worktree skill.*handoff skill/s) as string,
      });
    }

    expect(session.callTool('read')).toBeUndefined();
  });

  it('leaves sessions in a worktree of a bare repository alone', async () => {
    const root = await createTemporaryBareRoot((cleanup) => cleanups.push(cleanup));

    await promisify(execFile)('git', ['worktree', 'add', '--quiet', '--orphan', 'main'], {
      cwd: root,
    });

    const session = await startSession(join(root, 'main'));

    expect(session.systemPrompt).toBeUndefined();
    expect(session.callTool('write')).toBeUndefined();
  });
});
