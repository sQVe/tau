import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxProvider } from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { resolveLoadout } from './loadout.js';
import * as loadoutModule from './loadout.js';
import { discoverProfiles, parseProfile } from './profiles.js';

const closure = (setting: string) => () => setting;

it('refuses distinct provider closures even when their source text matches', () => {
  const original = closure('original');
  const replacement = closure('replacement');

  expect(original.toString()).toBe(replacement.toString());
  expect(loadoutModule).toHaveProperty('providerCallbacksMatch');
  expect(loadoutModule.providerCallbacksMatch({ stream: original }, { stream: replacement })).toBe(
    false,
  );
  expect(loadoutModule.providerCallbacksMatch({ stream: original }, { stream: original })).toBe(
    true,
  );
});

const profile = (body: string) => `---\nname: worker\nrole: editing\nthinking: off\n---\n${body}`;

it('reproduces CLI provider integrations but refuses runtime headers and invalid authority', async ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-loadout-'));
  const originalArguments = process.argv;
  onTestFinished(() => {
    process.argv = originalArguments;
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_SUBAGENT_MODEL', '');
  const safety = join(
    dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
    'dist',
    'pi',
    'index.js',
  );
  const provider = fileURLToPath(new URL('./fixtures/controlledProvider.ts', import.meta.url));
  process.argv = [process.execPath, 'pi', '-e', safety, '-e', provider];
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    additionalExtensionPaths: [safety, provider],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  for (const registration of loader.getExtensions().runtime.pendingNativeProviderRegistrations) {
    runtime.registerNativeProvider(registration.provider);
  }
  const registry = new ModelRegistry(runtime);
  const context = { cwd: directory, modelRegistry: registry, isProjectTrusted: () => true };
  const pi = { getAllTools: () => [], getCommands: () => [] };
  const request = {
    profile: 'worker',
    permissions: 'trusted-full-tools',
    model: 'tau-worker-fixture/faux-1',
  };
  const resolved = await resolveLoadout(request, context, pi);
  const authStarted = Promise.withResolvers<undefined>();
  const stalledAuth =
    Promise.withResolvers<Awaited<ReturnType<ModelRegistry['getApiKeyAndHeaders']>>>();
  const authSpy = vi.spyOn(registry, 'getApiKeyAndHeaders').mockImplementation(() => {
    authStarted.resolve(undefined);
    return stalledAuth.promise;
  });
  const cancellation = new AbortController();
  let cancellationError: unknown;
  const pendingResolution = resolveLoadout(request, context, pi, cancellation.signal).catch(
    (error: unknown) => {
      cancellationError = error;
    },
  );
  await authStarted.promise;
  cancellation.abort(new Error('Resolution cancelled by parent.'));
  await new Promise((done) => setImmediate(done));
  const rejectedBeforeAuthFinished = cancellationError instanceof Error;
  stalledAuth.resolve({ ok: false, error: 'Fixture released after cancellation.' });
  await pendingResolution;
  authSpy.mockRestore();

  expect(rejectedBeforeAuthFinished).toBe(true);
  expect(resolved.integrations).toContain(provider);
  expect(resolved.permissions).toBe('trusted-full-tools');
  expect(resolved.thinking).toBe('off');
  await expect(resolveLoadout({ ...request, harness: 'codex' }, context, pi)).rejects.toThrow(
    'Only Pi',
  );
  await expect(
    resolveLoadout({ ...request, permissions: 'read-only' }, context, pi),
  ).rejects.toThrow('trusted-full-tools');
  await expect(
    resolveLoadout(request, { ...context, isProjectTrusted: () => false }, pi),
  ).rejects.toThrow('trusted project');
  await expect(resolveLoadout({ ...request, profile: 'missing' }, context, pi)).rejects.toThrow(
    'not found',
  );
  await expect(resolveLoadout({ ...request, model: 'missing/model' }, context, pi)).rejects.toThrow(
    'unavailable',
  );
  const originalProvider = registry.getRegisteredNativeProvider('tau-worker-fixture');
  if (!originalProvider) {
    throw new Error('Fixture provider missing.');
  }
  registry.registerProvider({ ...originalProvider, headers: { 'X-Worker-Test': 'runtime-only' } });
  await expect(resolveLoadout(request, context, pi)).rejects.toThrow(
    'cannot reproduce parent provider',
  );
  const replacement = fauxProvider({
    provider: 'tau-worker-fixture',
    api: 'tau-worker-fixture',
  }).provider;
  expect(replacement.streamSimple.toString()).toBe(originalProvider.streamSimple.toString());
  registry.registerProvider({ ...replacement, auth: originalProvider.auth });
  await expect(resolveLoadout(request, context, pi)).rejects.toThrow(
    'cannot reproduce parent provider',
  );
  process.argv = [process.execPath, 'pi'];
  await expect(resolveLoadout(request, context, pi)).rejects.toThrow('CC Safety Net');
});

it('resolves profile precedence and refuses discarded isolation and transcript settings', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-profiles-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, 'agents'));
  mkdirSync(join(directory, '.pi', 'agents'), { recursive: true });
  writeFileSync(join(directory, 'agents', 'worker.md'), profile('User instructions.'));
  writeFileSync(join(directory, '.pi', 'agents', 'worker.md'), profile('Project instructions.'));

  expect(
    discoverProfiles(directory, directory, true).find((entry) => entry.name === 'worker')
      ?.instructions,
  ).toBe('Project instructions.');
  expect(
    discoverProfiles(directory, directory, false).find((entry) => entry.name === 'worker')
      ?.instructions,
  ).toBe('User instructions.');
  expect(() =>
    parseProfile('---\nrole: editing\nsession-mode: fork\n---\nTask', 'worker', 'fixture'),
  ).toThrow('lineage-only');
  expect(() =>
    parseProfile('---\nrole: editing\ntools: read\n---\nTask', 'worker', 'fixture'),
  ).toThrow('Unsupported');
});
