import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { workerFixture } from '../src/extensions/subagents/fixtures/workerLoadout.js';
import { checkWorkerRuntime, resolveLoadout } from '../src/extensions/subagents/loadout.js';
import { workerArguments } from '../src/extensions/subagents/workerCommand.js';
import { workerTools } from '../src/extensions/subagents/workerTools.js';
import { skillTools } from '../src/skillTools.js';
import { fakeExtensionApi } from './extensionApi.js';

const safetyPath = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

it('starts a qa worker with verification_record registered', async ({ onTestFinished }) => {
  const { directory, model, context, request } = await workerFixture(onTestFinished);

  const loadout = resolveLoadout({ ...request, profile: 'qa' }, context, [], {
    launchingRole: 'lead',
  });

  const tools = workerTools(loadout, skillTools);

  const recordPath = workerArguments('/records/session.jsonl', loadout, [], skillTools).find(
    (argument) => argument.endsWith('verification/workerRecord.ts'),
  );

  if (recordPath === undefined) {
    throw new Error('The qa worker command does not load the verification record extension.');
  }

  const recordModule = await vi.importActual<{ default: (pi: ExtensionAPI) => void }>(
    pathToFileURL(recordPath).href,
  );

  const api = fakeExtensionApi();

  recordModule.default(api.pi);

  const setActiveTools = vi.fn<ExtensionAPI['setActiveTools']>();

  const registeredTools = [
    ...tools.filter((name) => name !== 'verification_record').map((name) => ({ name })),
    ...[...api.tools.keys()].map((name) => ({ name })),
  ];

  const pi = {
    getThinkingLevel: () => loadout.thinking,
    getCommands: () => [
      { name: 'cc-safety-net', source: 'extension', sourceInfo: { path: safetyPath } },
    ],
    getAllTools: () => registeredTools,
    setActiveTools,
  } as unknown as Parameters<typeof checkWorkerRuntime>[1];

  const worker: Parameters<typeof checkWorkerRuntime>[2] = {
    model,
    cwd: directory,
    isProjectTrusted: () => true,
  };

  expect(() => {
    checkWorkerRuntime(loadout, pi, worker, tools);
  }).not.toThrow();

  expect(setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(['verification_record']));
});
