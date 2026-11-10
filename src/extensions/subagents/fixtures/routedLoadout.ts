import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SlashCommandInfo } from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import * as loadoutModule from '../loadout.js';
import type { RoutedLoadout } from '../loadout.js';

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

export const resolveRoutedLoadout = (
  input: Parameters<typeof loadoutModule.resolveRoutedLoadout>[0],
  context: Parameters<typeof loadoutModule.resolveRoutedLoadout>[1],
  commands: SlashCommandInfo[] = workerSkillCommands,
  signal?: AbortSignal,
): Promise<RoutedLoadout> => loadoutModule.resolveRoutedLoadout(input, context, commands, signal);

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

export const answered = (label: string, confidence: number): object => ({
  stopReason: 'stop',
  answers: { route: { type: 'choice', choice: label, probabilities: {}, confidence } },
});

export const classifierProvider = 'tau-classifier-fixture';

export const classifierId = 'router';

const classifierReference = `${classifierProvider}/${classifierId}`;

const createRoutedFixture = async (
  onTestFinished: (callback: () => void) => void,
  confidence?: number,
  reasoning = false,
) => {
  const fixture = await workerFixture(onTestFinished, reasoning);
  const { directory, model } = fixture;
  const profileModel = `${model.provider}/${model.id}`;

  const route = {
    classifier: classifierReference,
    question: 'How wide is this brief?',
    ...(confidence === undefined ? {} : { confidence }),
    labels: {
      narrow: { criterion: 'A lookup about known code.', model: haiku },
      wide: { criterion: 'An investigation across many files.', model: profileModel },
    },
  };

  writeFileSync(
    join(directory, 'tau.json'),
    JSON.stringify({
      profiles: {
        scout: { model: profileModel, route },
        worker: { model: profileModel, route },
        reviewer: { model: profileModel },
      },
    }),
  );

  const classify = vi.fn<(...parameters: unknown[]) => Promise<unknown>>();
  const findOfType = vi.fn<(...parameters: unknown[]) => void>();
  const hasClassifier = { value: true };

  const registry = Object.assign(Object.create(fixture.context.modelRegistry) as ModelRegistry, {
    findOfType: (...parameters: unknown[]) => {
      findOfType(...parameters);

      return hasClassifier.value ? { id: classifierId } : undefined;
    },
    classify,
  });

  const context = { ...fixture.context, modelRegistry: registry };

  return { ...fixture, context, classify, findOfType, hasClassifier, profileModel };
};

export type RoutedFixture = Awaited<ReturnType<typeof createRoutedFixture>>;

export const routedFixture: (
  onTestFinished: (callback: () => void) => void,
  confidence?: number,
) => Promise<RoutedFixture> = createRoutedFixture;

export const thinkingRoutedFixture = (
  onTestFinished: (callback: () => void) => void,
  confidence?: number,
): Promise<RoutedFixture> => createRoutedFixture(onTestFinished, confidence, true);
