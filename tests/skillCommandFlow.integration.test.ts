import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { TestContext } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import { createBoundSession } from './piSession.js';

// Real Pi sessions need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

const packageRoot = resolve(import.meta.dirname, '..');

const createSession = async (registerCleanup: TestContext['onTestFinished']) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-skill-command-'));
  const agentDirectory = await mkdtemp(join(tmpdir(), 'tau-skill-command-agent-'));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));
  registerCleanup(() => rm(agentDirectory, { recursive: true, force: true }));

  const faux = fauxProvider({ provider: 'tau-skill-command-test' });

  const { session } = await createBoundSession(registerCleanup, {
    cwd: directory,
    agentDirectory,
    providers: [faux],
    tools: ['read'],
    extensionPaths: [join(packageRoot, 'src/extensions')],
    skillPaths: [join(packageRoot, 'skills')],
  });

  return { session, faux };
};

const lastUserTextOf = (context: { messages: { role: string; content: unknown }[] }) => {
  const user = context.messages.findLast((message) => message.role === 'user');

  if (!Array.isArray(user?.content)) {
    throw new TypeError(`No user message with content blocks: ${JSON.stringify(context.messages)}`);
  }

  return (user.content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
};

describe('skill commands', () => {
  it.for(['bro', 'commit'])(
    'sends the %s skill body to the model',
    async (skillName, { onTestFinished }) => {
      const { session, faux } = await createSession(onTestFinished);
      const { promise: sentText, resolve: resolveSentText } = Promise.withResolvers<string>();

      faux.setResponses([
        (context) => {
          resolveSentText(lastUserTextOf(context));

          return fauxAssistantMessage('Done.');
        },
      ]);

      await session.prompt(`/${skillName} extra context`);

      const text = await sentText;

      expect(text).toMatch(new RegExp(`^<skill name="${skillName}" `));
      expect(text).toMatch(/<\/skill>\n\nextra context$/);
    },
  );
});
