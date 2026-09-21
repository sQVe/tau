import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import {
  getBuiltinModel,
  getBuiltinModelDataGeneratedAt,
} from '@earendil-works/pi-ai/providers/all';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { fixtureLoadout } from './fixtures/loadout.js';
import {
  checkWorkerRuntime,
  integrationFingerprint,
  modelFingerprint,
  providerFingerprint,
  resolveLoadout,
  validateSavedLoadout,
} from './loadout.js';

const fixture = async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tau-cached-catalog-')));
  const originalArguments = process.argv;
  onTestFinished(() => {
    process.argv = originalArguments;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('PI_OFFLINE', undefined);
  const fetch = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('Catalog reconstruction must not fetch.');
  });
  vi.stubGlobal('fetch', fetch);

  const safety = realpathSync(
    join(
      dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
      'dist',
      'pi',
      'index.js',
    ),
  );
  process.argv = [process.execPath, 'pi', '--no-extensions', '-e', safety];
  writeFileSync(
    join(directory, 'models.json'),
    JSON.stringify({ providers: { 'openai-codex': { apiKey: 'catalog-fixture-key' } } }),
  );

  const bundled = getBuiltinModel('openai-codex', 'gpt-6-astra');
  const cached = {
    ...bundled,
    compat: { ...bundled.compat, supportsMidConvoSystemMessages: true },
  };
  const catalogPath = join(directory, 'models-store.json');
  const saveCatalog = (supportsMidConvoSystemMessages: boolean) => {
    writeFileSync(
      catalogPath,
      JSON.stringify({
        'openai-codex': {
          models: [{ ...cached, compat: { ...cached.compat, supportsMidConvoSystemMessages } }],
          lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
          checkedAt: 0,
        },
      }),
    );
  };
  saveCatalog(true);

  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: join(directory, 'models.json'),
  });
  const modelRegistry = new ModelRegistry(runtime);
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
  const model = modelRegistry.find(cached.provider, cached.id);

  if (!model) {
    throw new Error('Cached fixture model missing.');
  }

  expect(model).toEqual(cached);
  expect(modelFingerprint(model)).not.toBe(modelFingerprint(bundled));
  const context = { cwd: directory, modelRegistry, model, isProjectTrusted: () => true };
  const saved = {
    ...fixtureLoadout(directory),
    model: `${model.provider}/${model.id}`,
    modelFingerprint: modelFingerprint(model),
    providerFingerprint: await providerFingerprint(modelRegistry, model),
    providerFingerprintVersion: 2 as const,
    thinking: 'medium' as const,
    noExtensions: true,
    integrations: [safety],
    integrationFingerprint: integrationFingerprint([safety]),
    safetyExtension: safety,
  };
  const parent = { getAllTools: () => [], getCommands: () => [] };
  const worker = {
    getThinkingLevel: () => saved.thinking,
    getCommands: () => [{ name: 'cc-safety-net', sourceInfo: { path: safety } }],
    getAllTools: () => saved.tools.map((name) => ({ name })),
    setActiveTools: vi.fn<(tools: string[]) => void>(),
  } as unknown as Parameters<typeof checkWorkerRuntime>[1];
  const request = {
    profile: 'worker',
    permissions: 'trusted-full-tools',
    model: saved.model,
  };
  const operations = {
    'fresh launch': (signal?: AbortSignal) => resolveLoadout(request, context, parent, signal),
    'saved replay': (signal?: AbortSignal) => validateSavedLoadout(saved, context, signal),
    'worker runtime': (signal?: AbortSignal) => checkWorkerRuntime(saved, worker, context, signal),
  };

  return { operations, saved, worker, fetch, catalogPath, saveCatalog, cached };
};

it.each(['fresh launch', 'saved replay', 'worker runtime'] as const)(
  'restores cached model metadata without network during %s',
  async (phase) => {
    const setup = await fixture();
    const catalogBefore = readFileSync(setup.catalogPath, 'utf8');

    const result = await setup.operations[phase]();

    const freshLaunchResult: unknown = expect.objectContaining({
      modelFingerprint: setup.saved.modelFingerprint,
    });
    const expectedResults = {
      'fresh launch': freshLaunchResult,
      'saved replay': setup.saved,
      'worker runtime': undefined,
    };
    const activatedTools = phase === 'worker runtime' ? [[setup.saved.tools]] : [];

    expect(result).toEqual(expectedResults[phase]);
    expect(vi.mocked(setup.worker.setActiveTools).mock.calls).toEqual(activatedTools);
    expect(setup.fetch).not.toHaveBeenCalled();
    expect(readFileSync(setup.catalogPath, 'utf8')).toBe(catalogBefore);
  },
);

it('refuses a saved worker tool list that is missing current subagent tools', async () => {
  const setup = await fixture();
  setup.saved.tools = setup.saved.tools.filter((tool) => tool !== 'subagent_question');

  await expect(setup.operations['worker runtime']()).rejects.toThrow('Saved worker tools');
  expect(setup.worker.setActiveTools).not.toHaveBeenCalled();
});

it('refuses a saved worker tool list that activates the direct questionnaire', async () => {
  const setup = await fixture();
  setup.saved.tools = [...setup.saved.tools, 'ask_user_question'];

  await expect(setup.operations['worker runtime']()).rejects.toThrow('Saved worker tools');
  expect(setup.worker.setActiveTools).not.toHaveBeenCalled();
});

it.each(['fresh launch', 'saved replay', 'worker runtime'] as const)(
  'refuses changed cached compat during %s',
  async (phase) => {
    const setup = await fixture();
    setup.saveCatalog(false);
    const messages = {
      'fresh launch': 'Worker cannot reproduce the parent model configuration.',
      'saved replay': 'Saved worker model or thinking cannot be reproduced;',
      'worker runtime': 'Worker cannot reproduce its current model configuration.',
    };

    await expect(setup.operations[phase]()).rejects.toThrow(messages[phase]);

    expect(setup.worker.setActiveTools).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
  },
);

it('restores cached model metadata with PI_OFFLINE set', async () => {
  const setup = await fixture();
  vi.stubEnv('PI_OFFLINE', '1');

  const resolved = await setup.operations['fresh launch']();
  const replayed = await setup.operations['saved replay']();
  await setup.operations['worker runtime']();

  expect(resolved).toMatchObject({ modelFingerprint: setup.saved.modelFingerprint });
  expect(replayed).toEqual(setup.saved);
  expect(setup.worker.setActiveTools).toHaveBeenCalledWith(setup.saved.tools);
  expect(setup.fetch).not.toHaveBeenCalled();
});

it.each(['fresh launch', 'saved replay', 'worker runtime'] as const)(
  'refuses cancelled cached model validation during %s',
  async (phase) => {
    const setup = await fixture();
    const reason = new Error('Catalog validation cancelled.');
    const signal = AbortSignal.abort(reason);

    await expect(setup.operations[phase](signal)).rejects.toBe(reason);

    expect(setup.worker.setActiveTools).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
  },
);

it.each(['fresh launch', 'saved replay', 'worker runtime'] as const)(
  'preserves cancellation during model store reads for %s',
  async (phase) => {
    const setup = await fixture();
    const cancellation = new AbortController();
    const reason = new Error('Cancelled while reading the model store.');
    const store = new InMemoryModelsStore();
    await store.write(setup.cached.provider, {
      models: [setup.cached],
      lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
    });
    const read = store.read.bind(store);
    const storeRead = vi.spyOn(store, 'read').mockImplementation((provider, options) => {
      if (provider === setup.cached.provider) {
        cancellation.abort(reason);
      }

      return read(provider, options);
    });
    const createRuntime = ModelRuntime.create.bind(ModelRuntime);
    const create = vi
      .spyOn(ModelRuntime, 'create')
      .mockImplementationOnce((options) => createRuntime({ ...options, modelsStore: store }));
    onTestFinished(() => {
      create.mockRestore();
      storeRead.mockRestore();
    });

    await expect(setup.operations[phase](cancellation.signal)).rejects.toBe(reason);

    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ signal: cancellation.signal }),
    );
    expect(storeRead).toHaveBeenCalledWith(setup.cached.provider, expect.anything());
    expect(setup.worker.setActiveTools).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
  },
);
