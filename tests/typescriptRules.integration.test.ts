import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import { SessionManager, createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import instructionsExtension from '../src/extensions/instructions.js';
import { createBoundSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const rules = readFileSync(new URL('../src/instructions/typescript.md', import.meta.url), 'utf8');

const setup = async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-typescript-rules-');

  vi.stubEnv('TAU_ROLE', undefined);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  writeFileSync(join(directory, 'source.ts'), 'original');
  const provider = fauxProvider({ provider: 'tau-typescript-rules' });

  const errors: unknown[] = [];

  onTestFinished(() => {
    expect(errors).toEqual([]);
  });

  const created = await createBoundSession(
    onTestFinished,
    {
      cwd: directory,
      agentDirectory: directory,
      providers: [provider],
      tools: ['read', 'edit', 'write', 'codemode'],
      sessionManager: SessionManager.create(directory, join(directory, 'sessions')),
      extensionFactories: [instructionsExtension, createCodemodeExtension({ mode: 'on' })],
    },
    { onError: (error) => errors.push(error) },
  );

  return { ...created, provider, directory };
};

it.for(['direct', 'nested'])(
  'delivers TypeScript rules before the next model request after a %s read',
  async (access) => {
    const { provider, session } = await setup();
    const requests: string[] = [];

    const call =
      access === 'direct'
        ? fauxToolCall('read', { path: 'source.ts' })
        : fauxToolCall('codemode', { code: "await tools.read({ path: 'source.ts' });" });

    provider.setResponses([
      (context) => {
        requests.push(JSON.stringify(context.messages));

        return fauxAssistantMessage([call]);
      },
      (context) => {
        requests.push(JSON.stringify(context.messages));

        return fauxAssistantMessage('Done.');
      },
    ]);

    await session.prompt('Read the source.');

    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toContain('Tau TypeScript instructions');
    expect(requests[1]).toContain('Tau TypeScript instructions');
    const customMessages = session.state.messages.filter((message) => message.role === 'custom');

    expect(customMessages).toContainEqual(
      expect.objectContaining({
        customType: 'tau-typescript-rules',
        content: rules,
      }),
    );
  },
);

it('blocks sibling TypeScript changes from an uninformed request and allows a reconsidered retry', async () => {
  const { provider, session, directory } = await setup();
  const snapshots: string[] = [];
  const requests: string[] = [];

  provider.setResponses([
    fauxAssistantMessage([
      fauxToolCall('write', { path: 'source.ts', content: 'first' }),
      fauxToolCall('write', { path: 'source.ts', content: 'sibling' }),
    ]),
    (context) => {
      snapshots.push(readFileSync(join(directory, 'source.ts'), 'utf8'));
      requests.push(JSON.stringify(context.messages));

      return fauxAssistantMessage([
        fauxToolCall('write', { path: 'source.ts', content: 'reconsidered' }),
      ]);
    },
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Change the source.');

  expect(snapshots).toEqual(['original']);
  expect(requests[0]).toMatch(/reconsider/iu);
  expect(requests[0]).toContain('Tau TypeScript instructions');
  expect(readFileSync(join(directory, 'source.ts'), 'utf8')).toBe('reconsidered');
});

it.for(['reload', 'resume'])(
  'restores TypeScript rules in the append section after %s',
  async (operation) => {
    const { provider, session, directory } = await setup();

    provider.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'source.ts' })]),
      fauxAssistantMessage('Read.'),
    ]);

    await session.prompt('Read the source.');

    let activeSession = session;

    if (operation === 'reload') {
      await session.reload();
    } else {
      const sessionFile = session.sessionManager.getSessionFile();

      if (sessionFile === undefined) {
        throw new Error('Expected a saved Pi session.');
      }

      const resumed = await createBoundSession(onTestFinished, {
        cwd: directory,
        agentDirectory: directory,
        providers: [provider],
        tools: ['read', 'write'],
        sessionManager: SessionManager.open(sessionFile),
        sessionStartEvent: { type: 'session_start', reason: 'resume' },
        extensionFactories: [instructionsExtension],
      });

      activeSession = resumed.session;
    }

    const prompts: string[] = [];

    provider.setResponses([
      (context) => {
        prompts.push(getCurrentSystemPrompt(context.messages));

        return fauxAssistantMessage('Done.');
      },
    ]);

    await activeSession.prompt('Continue.');

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(rules);
  },
);

it('keeps a real non-TypeScript session free of TypeScript rules', async () => {
  const { provider, session, directory } = await setup();
  const requests: string[] = [];

  writeFileSync(join(directory, 'README.md'), 'Documentation.');

  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('read', { path: 'README.md' })]),
    (context) => {
      requests.push(JSON.stringify(context.messages));

      return fauxAssistantMessage('Done.');
    },
  ]);

  await session.prompt('Read the documentation.');

  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain('Tau TypeScript instructions');

  expect(session.sessionManager.getBranch()).not.toContainEqual(
    expect.objectContaining({ customType: 'tau-typescript-rules' }),
  );
});
