import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { FauxResponseStep } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { expect } from 'vitest';

import type { createTestObservation } from '../src/extensions/tdd/observation.js';
import { initializeRepository } from './gitRepository.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createPiSession } from './piSession.js';

interface ToolResult {
  details: Awaited<ReturnType<ReturnType<typeof createTestObservation>['run']>>;
  content: { type: 'text'; text: string }[];
}

let counter = 0;

export const createWorktree = async (cleanup: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-tdd-'));
  cleanup(() => rm(cwd, { recursive: true, force: true }));

  await initializeRepository(cwd);
  await symlink(resolve(import.meta.dirname, '../node_modules'), join(cwd, 'node_modules'), 'dir');
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'vite.config.ts'), 'export default {};');
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; it('required behavior', () => expect(1).toBe(2));",
  );

  return cwd;
};

export const createHarness = async (
  cleanup: TestContext['onTestFinished'],
  extensionFactories: ExtensionFactory[] = [],
  reused?: string,
) => {
  const cwd = reused ?? (await createWorktree(cleanup));
  const agentDirectory = join(cwd, 'agent');

  isolateWebAccessConfig(agentDirectory, cleanup);
  counter += 1;

  const faux = fauxProvider({ provider: `tau-tdd-${counter}` });
  const { session, extensionsResult } = await createPiSession(cleanup, {
    cwd,
    agentDirectory,
    providers: [faux],
    tools: ['read', 'bash', 'edit', 'write', 'run_tests', 'commit'],
    extensionPaths: [
      resolve(import.meta.dirname, '../src/extensions'),
      resolve(import.meta.dirname, '../node_modules/@juicesharp/rpiv-ask-user-question/index.ts'),
      resolve(import.meta.dirname, '../node_modules/pi-web-access/index.ts'),
    ],
    extensionFactories,
  });

  expect(extensionsResult.errors).toEqual([]);
  await session.bindExtensions({});

  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  const call = async (
    toolName: string,
    input: Record<string, unknown>,
    between: FauxResponseStep[] = [],
  ) => {
    events.length = 0;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(toolName, input)]),
      ...between,
      fauxAssistantMessage('Done.'),
    ]);

    await session.prompt('Call the tool.');

    const event = events.find(
      (entry) => entry.type === 'tool_execution_end' && entry.toolName === toolName,
    );

    if (event?.type !== 'tool_execution_end') {
      throw new Error(`Missing ${toolName} result`);
    }

    return event;
  };

  const run = async (overrides = {}) => {
    const event = await call('run_tests', {
      behavior: 'required behavior',
      testFullName: 'required behavior',
      files: ['behavior.test.ts'],
      scope: 'focused',
      ...overrides,
    });

    expect(event.isError).toBe(false);

    const result = event.result as ToolResult;
    const directory = result.details.report.diagnostics?.directory;

    if (directory !== undefined) {
      cleanup(() => rm(directory, { recursive: true, force: true }));
    }

    return result;
  };

  return { cwd, session, faux, events, run, call };
};
