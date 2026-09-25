import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { createTemporaryBareRoot } from './gitRepository.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createBoundSession } from './piSession.js';

// Real Pi sessions and Git commands need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

const tauExtensionsPath = resolve(import.meta.dirname, '../src/extensions');

const bundledQuestionExtensionPath = resolve(
  import.meta.dirname,
  '../node_modules/@juicesharp/rpiv-ask-user-question/index.ts',
);

const bundledWebAccessExtensionPath = resolve(
  import.meta.dirname,
  '../node_modules/pi-web-access/index.ts',
);

const snapshot = async (directory: string) => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());

  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const path = join(file.parentPath, file.name);

        return [path, await readFile(path, 'utf8')] as const;
      }),
    ),
  );
};

describe('bare root guard in Pi', () => {
  it('refuses writes, edits, and worker launches without changing the root', async ({
    onTestFinished,
  }) => {
    const root = await createTemporaryBareRoot(onTestFinished);
    const agentDirectory = await mkdtemp(join(tmpdir(), 'tau-bare-root-agent-'));

    onTestFinished(() => rm(agentDirectory, { recursive: true, force: true }));
    isolateWebAccessConfig(agentDirectory, onTestFinished);
    await writeFile(join(root, 'notes.md'), 'original\n');

    const faux = fauxProvider({ provider: 'tau-test' });

    const { session } = await createBoundSession(onTestFinished, {
      cwd: root,
      agentDirectory,
      providers: [faux],
      tools: ['read', 'write', 'edit', 'subagent', 'subagent_follow_up'],
      extensionPaths: [
        tauExtensionsPath,
        bundledQuestionExtensionPath,
        bundledWebAccessExtensionPath,
      ],
    });

    const events: AgentSessionEvent[] = [];

    session.subscribe((event) => {
      events.push(event);
    });

    const before = await snapshot(root);

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('write', { path: 'new.md', content: 'new\n' }),
        fauxToolCall('edit', {
          path: 'notes.md',
          edits: [{ oldText: 'original', newText: 'changed' }],
        }),
        fauxToolCall('subagent', {
          task: 'Implement it.',
          profile: 'worker',
          permissions: 'trusted-full-tools',
          timeoutSeconds: 60,
        }),
        fauxToolCall('subagent_follow_up', {
          sourceTaskId: 'task-1',
          task: 'Continue.',
          timeoutSeconds: 60,
          settingsUnchanged: true,
        }),
      ]),
      fauxAssistantMessage('Refused.'),
    ]);

    await session.prompt('Change the notes and start a worker.');

    const results = events.filter((event) => event.type === 'tool_execution_end');

    expect(results.map((result) => result.toolName).toSorted()).toEqual([
      'edit',
      'subagent',
      'subagent_follow_up',
      'write',
    ]);

    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.result)).toMatch(/worktree skill.*handoff skill/);
    }

    expect(await snapshot(root)).toEqual(before);
  });
});
