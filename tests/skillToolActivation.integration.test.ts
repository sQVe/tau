import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import type { FauxResponseFactory } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import tauSkillsExtension from '../src/extensions/tauSkills/tauSkills.js';
import { createBoundSession } from './piSession.js';

interface RequestSeen {
  toolNames: string[];
  systemPrompt: string;
}

// Real Pi sessions need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

const toolSnippet = 'Run the demo step.';

const tauExtensionPath = resolve(import.meta.dirname, '../src/tau.ts');

const createSession = async (registerCleanup: TestContext['onTestFinished']) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-skill-tool-'));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));

  const skillsDirectory = join(directory, 'skills');
  const skillFile = join(skillsDirectory, 'demo', 'SKILL.md');
  await mkdir(join(skillsDirectory, 'demo'), { recursive: true });

  await writeFile(
    skillFile,
    '---\nname: demo\ndescription: Run the demo workflow.\n---\n\nCall demo_tool.\n',
  );

  const toolCalls: string[] = [];

  const registerDemo = (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'demo_tool',
      label: 'Demo',
      description: 'Run the demo step.',
      promptSnippet: toolSnippet,
      parameters: Type.Object({}),
      defaultActive: false,
      execute: (toolCallId) => {
        toolCalls.push(toolCallId);

        return Promise.resolve({ content: [{ type: 'text', text: 'Demo ran.' }], details: {} });
      },
    });

    tauSkillsExtension(pi, skillsDirectory, { demo: ['demo_tool'] });
  };

  const faux = fauxProvider({ provider: 'tau-skill-tool-test' });

  const { session } = await createBoundSession(registerCleanup, {
    cwd: directory,
    agentDirectory: join(directory, 'agent'),
    providers: [faux],
    extensionFactories: [registerDemo],
    skillPaths: [skillsDirectory],
  });

  const requests: RequestSeen[] = [];

  const respond =
    (message: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory =>
    (context) => {
      requests.push({
        toolNames: getCurrentTools(context.messages).map((tool) => tool.name),
        systemPrompt: getCurrentSystemPrompt(context.messages),
      });

      return message;
    };

  return { session, faux, skillFile, toolCalls, requests, respond };
};

it('lets the model call a skill tool on the request after it reads the SKILL.md', async ({
  onTestFinished,
}) => {
  const { session, faux, skillFile, toolCalls, requests, respond } =
    await createSession(onTestFinished);

  faux.setResponses([
    respond(fauxAssistantMessage([fauxToolCall('read', { path: skillFile })])),
    respond(fauxAssistantMessage([fauxToolCall('demo_tool', {}, { id: 'demo-call' })])),
    respond(fauxAssistantMessage('Done.')),
  ]);

  await session.prompt('Run the demo workflow.');

  expect(requests).toHaveLength(3);
  expect(requests[0]?.toolNames).not.toContain('demo_tool');
  expect(requests[0]?.systemPrompt).not.toContain(toolSnippet);
  expect(requests[1]?.toolNames).toContain('demo_tool');
  expect(requests[1]?.systemPrompt).toContain(toolSnippet);
  expect(toolCalls).toEqual(['demo-call']);
});

it('lets the model call a skill tool on the first request after the skill command', async ({
  onTestFinished,
}) => {
  const { session, faux, toolCalls, requests, respond } = await createSession(onTestFinished);

  expect(session.getActiveToolNames()).not.toContain('demo_tool');

  const finalResponse = respond(fauxAssistantMessage('Done.'));
  const { promise: finished, resolve: finish } = Promise.withResolvers<undefined>();

  faux.setResponses([
    respond(fauxAssistantMessage([fauxToolCall('demo_tool', {}, { id: 'demo-call' })])),
    (...request) => {
      finish(undefined);

      return finalResponse(...request);
    },
  ]);

  // The command queues the skill message as a follow-up, so the run starts after prompt returns.
  await session.prompt('/demo');
  await finished;

  expect(requests).toHaveLength(2);
  expect(requests[0]?.toolNames).toContain('demo_tool');
  expect(requests[0]?.systemPrompt).toContain(toolSnippet);
  expect(toolCalls).toEqual(['demo-call']);
});

it('turns on the code_review tool when the code-review skill runs', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-code-review-tool-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const faux = fauxProvider({ provider: 'tau-code-review-tool-test' });

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: join(directory, 'agent'),
    providers: [faux],
    extensionPaths: [tauExtensionPath],
  });

  const toolNamesSeen: string[][] = [];
  const { promise: finished, resolve: finish } = Promise.withResolvers<undefined>();

  faux.setResponses([
    (context) => {
      toolNamesSeen.push(getCurrentTools(context.messages).map((tool) => tool.name));
      finish(undefined);

      return fauxAssistantMessage('Done.');
    },
  ]);

  expect(session.getActiveToolNames()).not.toContain('code_review');

  await session.prompt('/code-review');
  await finished;

  expect(toolNamesSeen[0]).toContain('code_review');
});
