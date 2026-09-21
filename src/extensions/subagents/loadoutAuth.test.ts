import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { asPiLoadout } from './fixtures/loadout.js';
import { checkWorkerRuntime, resolveLoadout, validateSavedLoadout } from './loadout.js';
import type { Loadout } from './types.js';

const fixture = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tau-stale-auth-')));
  const originalArguments = process.argv;
  onTestFinished(() => {
    process.argv = originalArguments;
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('OPENAI_API_KEY', '');
  const safety = realpathSync(
    join(
      dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
      'dist',
      'pi',
      'index.js',
    ),
  );
  const herdrPiIntegration = fileURLToPath(
    new URL('./fixtures/herdrPiIntegration.ts', import.meta.url),
  );
  process.argv = [
    process.execPath,
    'pi',
    '--no-extensions',
    '-e',
    safety,
    '-e',
    herdrPiIntegration,
  ];
  const configure = (apiKey?: string) => {
    writeFileSync(
      join(directory, 'models.json'),
      JSON.stringify({
        providers: {
          openai: {
            api: 'openai-completions',
            baseUrl: 'https://fixture.invalid/v1',
            ...(apiKey ? { apiKey } : {}),
            models: [
              {
                id: 'fixture-model',
                name: 'Fixture',
                reasoning: false,
                input: ['text'],
                contextWindow: 4096,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
  };
  const createContext = async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(directory, 'auth.json'),
      modelsPath: join(directory, 'models.json'),
      refreshOnCreate: false,
    });
    const modelRegistry = new ModelRegistry(runtime);
    const model = modelRegistry.find('openai', 'fixture-model');

    if (!model) {
      throw new Error('Fixture model missing.');
    }

    return { cwd: directory, modelRegistry, model, isProjectTrusted: () => true };
  };
  const request = {
    profile: 'worker',
    permissions: 'trusted-full-tools',
    model: 'openai/fixture-model',
  };
  const parent = { getAllTools: () => [], getCommands: () => [] };
  const worker = (value: Loadout) => {
    const loadout = asPiLoadout(value);

    return {
      getThinkingLevel: () => loadout.thinking,
      getCommands: () => [{ name: 'cc-safety-net', sourceInfo: { path: safety } }],
      getAllTools: () => loadout.tools.map((name) => ({ name })),
      setActiveTools: vi.fn<(tools: string[]) => void>(),
    } as unknown as Parameters<typeof checkWorkerRuntime>[1];
  };

  return { directory, configure, createContext, request, parent, worker };
};

it.each(['fresh launch', 'saved replay', 'worker runtime'] as const)(
  'refuses stale literal auth during %s',
  async (phase) => {
    const setup = fixture();
    setup.configure('literal-A');
    const original = await setup.createContext();
    const saved = asPiLoadout(await resolveLoadout(setup.request, original, setup.parent));
    setup.configure('literal-B');
    const stale = await setup.createContext();
    expect(await stale.modelRegistry.getApiKeyAndHeaders(stale.model)).toMatchObject({
      ok: true,
      apiKey: 'literal-B',
    });

    if (phase !== 'fresh launch') {
      setup.configure('literal-A');
    }

    expect(await stale.modelRegistry.getApiKeyAndHeaders(stale.model)).toMatchObject({
      ok: true,
      apiKey: 'literal-B',
    });
    const worker = setup.worker(saved);
    const operations = {
      'fresh launch': () => resolveLoadout(setup.request, original, setup.parent),
      'saved replay': () => validateSavedLoadout(saved, stale),
      'worker runtime': () => checkWorkerRuntime(saved, worker, stale),
    };

    await expect(operations[phase]()).rejects.toThrow('cannot reproduce');
    expect(worker.setActiveTools).not.toHaveBeenCalled();
  },
);

it('allows Pi credential rotation between saved resolution and startup with unchanged configuration', async () => {
  const setup = fixture();
  setup.configure();
  const authPath = join(setup.directory, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'credential-A' } }));
  const original = await setup.createContext();
  expect(await original.modelRegistry.getApiKeyAndHeaders(original.model)).toMatchObject({
    ok: true,
    apiKey: 'credential-A',
  });
  const saved = asPiLoadout(await resolveLoadout(setup.request, original, setup.parent));
  writeFileSync(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'credential-B' } }));
  await original.modelRegistry.refresh({ allowNetwork: false });
  const refreshed = original;
  expect(await refreshed.modelRegistry.getApiKeyAndHeaders(refreshed.model)).toMatchObject({
    ok: true,
    apiKey: 'credential-B',
  });

  expect(await validateSavedLoadout(saved, refreshed)).toEqual(saved);
  const worker = setup.worker(saved);
  await checkWorkerRuntime(saved, worker, refreshed);
  expect(worker.setActiveTools).toHaveBeenCalledWith(saved.tools);
});
