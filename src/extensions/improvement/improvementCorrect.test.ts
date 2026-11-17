import { readFile, realpath } from 'node:fs/promises';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { classEventId } from '../../improvement/classIdentity.js';
import { parseEvent } from '../../improvement/event.js';
import improvementExtension from './improvement.js';

const sessionContext = (cwd: string) =>
  ({
    cwd,
    hasUI: false,
    ui: { setStatus: () => undefined },
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/sessions/one.jsonl',
    },
  }) as unknown as ExtensionToolContext;

const runTool = async (cwd: string, input: Record<string, unknown>) => {
  const fake = fakeExtensionApi();

  improvementExtension(fake.pi);
  const tool = fake.tools.get('improvement');

  if (tool === undefined) {
    throw new Error('The manager has no improvement tool.');
  }

  const result = await tool.execute('call-1', input, undefined, undefined, sessionContext(cwd));

  return result.details as Record<string, unknown>;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

it('records a correct pass through the improvement tool', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const project = await realpath(await createTemporaryRepository(onTestFinished));
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const details = await runTool(project, { action: 'record', kind: 'pass' });
  const paths = details['paths'];

  if (!Array.isArray(paths) || typeof paths[0] !== 'string') {
    throw new TypeError('The pass record returned no path.');
  }

  const path = paths[0];
  const event = parseEvent(path, await readFile(path, 'utf8'));

  expect(path.startsWith(project)).toBe(true);
  expect(details).toMatchObject({ failed: [] });
  expect(event).toMatchObject({ kind: 'pass', pass: 'correct' });
});

it('records a class decision and returns the class from correct', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const project = await realpath(await createTemporaryRepository(onTestFinished));
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-agent-');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const classRecord = await runTool(project, {
    action: 'record',
    kind: 'class',
    identity: 'lint-await',
    level: 'lint',
    summary: 'The await keyword was missing before an async call.',
    occurrences: ['correction-1', 'correction-2'],
  });

  await runTool(project, {
    action: 'record',
    kind: 'decision',
    class: classRecord['id'],
    choice: 'approved',
  });

  const proposed = {
    identity: 'lint-await',
    level: 'lint',
    summary: 'The await keyword was missing before an async call.',
    occurrences: ['correction-1', 'correction-2'],
    reverted: false,
    qaMiss: false,
  };

  const result = await runTool(project, { action: 'correct', classes: [proposed] });

  expect(result).toMatchObject({
    classes: [
      { ...proposed, id: classEventId('lint-await', proposed.occurrences), repeatCount: 2 },
    ],
    measures: { acceptanceRate: { value: 1, coverage: 1 } },
  });
});
