import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SlashCommandInfo } from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';

export const skillCommand = (name: string, path: string): SlashCommandInfo =>
  ({ name: `skill:${name}`, source: 'skill', sourceInfo: { path } }) as SlashCommandInfo;

export const tddPath = fileURLToPath(new URL('../../../skills/tdd/SKILL.md', import.meta.url));

export const benchmarkChecklistPath = fileURLToPath(
  new URL('../../../skills/benchmark-checklist/SKILL.md', import.meta.url),
);

export const workerSkillCommands = [
  skillCommand('tdd', tddPath),
  skillCommand('benchmark-checklist', benchmarkChecklistPath),
];

const createWorkerFixture = async (
  onTestFinished: (callback: () => void) => void,
  reasoning = false,
) => {
  const directory = realpathSync(temporaryDirectory(onTestFinished, 'tau-pi-loadout-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  const provider = fauxProvider({
    provider: 'tau-worker-fixture',
    models: [
      { id: 'faux-1', reasoning },
      { id: 'haiku', reasoning },
    ],
  });

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });

  runtime.registerNativeProvider(provider.provider);
  const model = provider.getModel();

  const notify = vi.fn<(message: string, level?: string) => void>();

  const context = {
    cwd: directory,
    modelRegistry: new ModelRegistry(runtime),
    scopedModels: [{ model }],
    isProjectTrusted: () => true,
    ui: { notify },
  };

  const request = { profile: 'worker', model: `${model.provider}/${model.id}` };

  return { directory, model, context, request, notify };
};

export type WorkerFixture = Awaited<ReturnType<typeof createWorkerFixture>>;

export const workerFixture: (
  onTestFinished: (callback: () => void) => void,
  reasoning?: boolean,
) => Promise<WorkerFixture> = createWorkerFixture;

export const thinkingWorkerFixture = (
  onTestFinished: (callback: () => void) => void,
): Promise<WorkerFixture> => createWorkerFixture(onTestFinished, true);

export const allowModels = (path: string, allowedModels: string[] | undefined): void => {
  if (allowedModels !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ allowedModels }));
  }
};

export const haiku = 'tau-worker-fixture/haiku';
