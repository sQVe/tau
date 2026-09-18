import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { resolveLoadout } from './loadout.js';
import * as loadoutModule from './loadout.js';
import { resolveProfile, parseProfile } from './profiles.js';

const closure = (setting: string) => () => setting;

it('allows only resolved API key rotation under explicitly versioned provider fingerprints', async ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-provider-version-'));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  const provider = fauxProvider({ provider: 'fingerprint-fixture' });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  let resolution = {
    auth: { apiKey: 'first', baseUrl: 'https://fixture.invalid', headers: { account: 'one' } },
    env: { REGION: 'one' },
  };
  const native = {
    ...provider.provider,
    auth: { apiKey: { name: 'Fixture', resolve: () => Promise.resolve(resolution) } },
  };
  runtime.registerNativeProvider(native);
  const registry = new ModelRegistry(runtime);
  const model = provider.getModel();
  const signal = new AbortController().signal;
  const legacy = await loadoutModule.providerFingerprint(registry, model, signal);
  const current = await loadoutModule.providerFingerprint(registry, model, signal, 2);
  resolution = { ...resolution, auth: { ...resolution.auth, apiKey: 'rotated' } };

  expect(await loadoutModule.providerFingerprint(registry, model, signal, 2)).toBe(current);
  expect(await loadoutModule.providerFingerprint(registry, model, signal)).not.toBe(legacy);
  const rotated = resolution;
  for (const changed of [
    { ...rotated, auth: { ...rotated.auth, baseUrl: 'https://changed.invalid' } },
    { ...rotated, auth: { ...rotated.auth, headers: { account: 'two' } } },
    { ...rotated, env: { REGION: 'two' } },
  ]) {
    resolution = changed;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Compare each independent auth mutation against the same saved fingerprint.
    expect(await loadoutModule.providerFingerprint(registry, model, signal, 2)).not.toBe(current);
  }
  resolution = rotated;
  const registration = vi
    .spyOn(registry, 'getRegisteredProviderConfig')
    .mockReturnValue({ apiKey: 'literal-one' });
  const literal = await loadoutModule.providerFingerprint(registry, model, signal, 2);
  registration.mockReturnValue({ apiKey: 'literal-two' });
  expect(await loadoutModule.providerFingerprint(registry, model, signal, 2)).not.toBe(literal);
  registration.mockRestore();
  const modelsPath = join(directory, 'models.json');
  writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { unrelated: { apiKey: 'literal-one' } } }),
  );
  const fileConfiguration = await loadoutModule.providerFingerprint(registry, model, signal, 2);
  expect(fileConfiguration).not.toBe(current);
  writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { unrelated: { apiKey: 'literal-two' } } }),
  );
  expect(await loadoutModule.providerFingerprint(registry, model, signal, 2)).not.toBe(
    fileConfiguration,
  );
  rmSync(modelsPath);

  const auth = vi.spyOn(registry, 'getApiKeyAndHeaders');
  auth.mockResolvedValueOnce({ ok: false, error: 'Refresh failed' });
  await expect(loadoutModule.providerFingerprint(registry, model, signal, 2)).rejects.toThrow(
    'authentication is unavailable',
  );
  const deferred =
    Promise.withResolvers<Awaited<ReturnType<ModelRegistry['getApiKeyAndHeaders']>>>();
  auth.mockReturnValueOnce(deferred.promise);
  const cancellation = new AbortController();
  const pending = loadoutModule.providerFingerprint(registry, model, cancellation.signal, 2);
  cancellation.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(auth).toHaveBeenCalledTimes(2);
  deferred.resolve({ ok: false, error: 'Finished after cancellation' });
  auth.mockRestore();
});

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

it('defaults bundled roles to medium effort without model or effort settings in markdown', () => {
  for (const name of ['investigator', 'worker']) {
    const source = new URL(`./profiles/${name}.md`, import.meta.url);
    const content = readFileSync(source, 'utf8');

    expect(content).not.toMatch(/^(?:model|thinking|effort):/m);
    expect(parseProfile(content, name, source.pathname)).toMatchObject({
      name,
      model: undefined,
      thinking: 'medium',
    });
  }
});

it('accepts blank and comment frontmatter lines without relaxing selected profile validation', () => {
  const content = profile('Custom instructions.').replace(
    'role: editing',
    '\n  # Role selection\nrole: editing\n \t\n# thinking follows',
  );

  expect(parseProfile(content, 'fallback', 'fixture')).toMatchObject({
    name: 'worker',
    role: 'editing',
    thinking: 'off',
  });
  expect(() => parseProfile('---\nrole: editing\nname:\n---\nTask', 'worker', 'fixture')).toThrow(
    'Malformed profile setting',
  );
  for (const setting of ['name: replacement', 'unknown: value', 'thinking: invalid']) {
    expect(() =>
      parseProfile(
        content.replace('---\nCustom', `${setting}\n---\nCustom`),
        'fallback',
        'fixture',
      ),
    ).toThrow(/Unsupported or duplicate|Invalid profile thinking/);
  }
});

it('preserves custom thinking profiles and rejects invalid settings without normalization', () => {
  expect(parseProfile(profile('Custom instructions.'), 'worker', 'fixture').thinking).toBe('off');
  for (const thinking of ['invalid', 'Medium', 'maximum']) {
    expect(() =>
      parseProfile(`---\nrole: editing\nthinking: ${thinking}\n---\nTask`, 'worker', 'fixture'),
    ).toThrow('Invalid profile thinking level');
  }
});

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
  const questionnaire = fileURLToPath(import.meta.resolve('@juicesharp/rpiv-ask-user-question'));
  const parentTools = fileURLToPath(new URL('./index.ts', import.meta.url));
  process.argv = [
    process.execPath,
    'pi',
    '--no-extensions',
    '-e',
    safety,
    '-e',
    provider,
    '-e',
    questionnaire,
    '-e',
    parentTools,
  ];
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    additionalExtensionPaths: [safety, provider, questionnaire, parentTools],
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
  const disabled = join(directory, 'disabled-package');
  mkdirSync(disabled);
  writeFileSync(
    join(disabled, 'package.json'),
    JSON.stringify({ pi: { extensions: ['index.js'] } }),
  );
  writeFileSync(
    join(disabled, 'index.js'),
    'throw new Error("Disabled package was rediscovered");',
  );
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ packages: [disabled] }));

  const resolved = await resolveLoadout(request, context, pi);
  expect(resolved).toMatchObject({ noExtensions: true, providerFingerprintVersion: 2 });
  expect(loadoutModule).toHaveProperty('validateSavedLoadout');
  expect(await loadoutModule.validateSavedLoadout(resolved, context)).toEqual(resolved);
  const selectedModel = registry.find('tau-worker-fixture', 'faux-1');
  if (!selectedModel) {
    throw new Error('Missing fixture model.');
  }
  const legacy = {
    ...resolved,
    providerFingerprintVersion: undefined,
    providerFingerprint: await loadoutModule.providerFingerprint(registry, selectedModel),
  };
  expect(await loadoutModule.validateSavedLoadout(legacy, context)).toEqual(legacy);
  const originalAuth = registry.getApiKeyAndHeaders.bind(registry);
  const rotatingAuth = vi
    .spyOn(registry, 'getApiKeyAndHeaders')
    .mockImplementation(async (model) => {
      const auth = await originalAuth(model);

      return auth.ok ? { ...auth, apiKey: 'rotated-token' } : auth;
    });
  await expect(loadoutModule.validateSavedLoadout(resolved, context)).rejects.toThrow(
    'cannot reproduce',
  );
  await expect(loadoutModule.validateSavedLoadout(legacy, context)).rejects.toThrow(
    'cannot reproduce',
  );
  rotatingAuth.mockRestore();
  expect(resolved.integrations).toEqual([safety, provider, questionnaire, parentTools]);
  expect(
    loader.getExtensions().extensions.some((extension) => extension.tools.has('subagent_history')),
  ).toBe(true);
  expect(resolved.tools).toContain('subagent_history');
  expect(resolved.tools).toContain('subagent_follow_up');
  expect(resolved.tools).toContain('subagent_question');
  expect(resolved.tools).not.toContain('ask_user_question');
  const legacyTools = {
    ...resolved,
    tools: resolved.tools.filter(
      (tool) =>
        !tool.startsWith('subagent_') || ['subagent_report', 'subagent_question'].includes(tool),
    ),
  };
  expect(await loadoutModule.validateSavedLoadout(legacyTools, context)).toEqual(legacyTools);
  const legacyQuestionnaire = { ...resolved, tools: [...resolved.tools, 'ask_user_question'] };
  expect(await loadoutModule.validateSavedLoadout(legacyQuestionnaire, context)).toEqual(
    legacyQuestionnaire,
  );
  rmSync(join(directory, 'settings.json'));
  const withoutModel = { profile: 'worker', permissions: 'trusted-full-tools' };
  await expect(resolveLoadout(withoutModel, context, pi)).rejects.toThrow('no fallback');
  vi.stubEnv('TAU_SUBAGENT_MODEL', request.model);
  expect((await resolveLoadout(withoutModel, context, pi)).model).toBe(request.model);

  mkdirSync(join(directory, 'agents'));
  const customProfile = join(directory, 'agents', 'worker.md');
  writeFileSync(
    customProfile,
    profile('Custom task.').replace('role: editing', `role: editing\nmodel: ${request.model}`),
  );
  vi.stubEnv('TAU_SUBAGENT_MODEL', 'missing/environment');
  expect(await loadoutModule.validateSavedLoadout(resolved, context)).toEqual(resolved);
  expect((await resolveLoadout(withoutModel, context, pi)).model).toBe(request.model);
  writeFileSync(
    customProfile,
    profile('Custom task.').replace('role: editing', 'role: editing\nmodel: missing/profile'),
  );
  expect(await loadoutModule.validateSavedLoadout(resolved, context)).toEqual(resolved);
  await expect(resolveLoadout(withoutModel, context, pi)).rejects.toThrow('missing/profile');
  expect((await resolveLoadout(request, context, pi)).model).toBe(request.model);
  await expect(resolveLoadout({ ...request, model: 'invalid model' }, context, pi)).rejects.toThrow(
    'no fallback',
  );
  rmSync(customProfile);
  expect(await loadoutModule.validateSavedLoadout(resolved, context)).toEqual(resolved);
  await expect(
    loadoutModule.validateSavedLoadout(resolved, { ...context, isProjectTrusted: () => false }),
  ).rejects.toThrow('trusted');
  await expect(
    loadoutModule.validateSavedLoadout({ ...resolved, thinking: 'high' }, context),
  ).rejects.toThrow('thinking');
  await expect(
    loadoutModule.validateSavedLoadout(
      { ...resolved, integrationFingerprint: 'f'.repeat(64) },
      context,
    ),
  ).rejects.toThrow('integration');

  await expect(
    loadoutModule.validateSavedLoadout({ ...resolved, providerFingerprintVersion: 99 }, context),
  ).rejects.toThrow('Invalid saved');
  await expect(
    loadoutModule.validateSavedLoadout({ ...resolved, modelFingerprint: 'f'.repeat(64) }, context),
  ).rejects.toThrow('model');
  await expect(
    loadoutModule.validateSavedLoadout({ ...resolved, cwd: join(directory, 'wrong') }, context),
  ).rejects.toThrow('cwd');
  await expect(
    loadoutModule.validateSavedLoadout(
      { ...resolved, agentDirectory: join(directory, 'wrong') },
      context,
    ),
  ).rejects.toThrow('directory');
  const cancelledReplay = AbortSignal.abort(new Error('Replay cancelled.'));
  await expect(
    loadoutModule.validateSavedLoadout(resolved, context, cancelledReplay),
  ).rejects.toThrow('Replay cancelled.');

  const invalidModelsPath = join(directory, 'models.json');
  writeFileSync(invalidModelsPath, '{');
  await expect(loadoutModule.validateSavedLoadout(resolved, context)).rejects.toThrow(
    'model configuration',
  );
  rmSync(invalidModelsPath);

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
  const failedAuth = vi
    .spyOn(registry, 'getApiKeyAndHeaders')
    .mockResolvedValueOnce({ ok: false, error: 'No credentials' });
  await expect(loadoutModule.validateSavedLoadout(resolved, context)).rejects.toThrow(
    'authentication is unavailable',
  );
  failedAuth.mockRestore();

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
  await expect(loadoutModule.validateSavedLoadout(resolved, context)).rejects.toThrow(
    'cannot reproduce current provider',
  );
  await expect(resolveLoadout(request, context, pi)).rejects.toThrow(
    'cannot reproduce current provider',
  );
  const replacement = fauxProvider({
    provider: 'tau-worker-fixture',
    api: 'tau-worker-fixture',
  }).provider;
  expect(replacement.streamSimple.toString()).toBe(originalProvider.streamSimple.toString());
  registry.registerProvider({ ...replacement, auth: originalProvider.auth });
  await expect(loadoutModule.validateSavedLoadout(resolved, context)).rejects.toThrow(
    'cannot reproduce current provider',
  );
  await expect(resolveLoadout(request, context, pi)).rejects.toThrow(
    'cannot reproduce current provider',
  );
  process.argv = [process.execPath, 'pi'];
  await expect(resolveLoadout(request, context, pi)).rejects.toThrow('CC Safety Net');
});

it('selects a valid named winner using the strict parser whitespace syntax', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-profile-whitespace-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const project = join(directory, '.pi', 'agents');
  mkdirSync(project, { recursive: true });
  const source = join(project, 'custom.md');
  const content = profile('Winning instructions.').replace('name: worker', 'name:\rworker');
  writeFileSync(source, content);

  expect(parseProfile(content, 'custom', source).name).toBe('worker');
  expect(resolveProfile(directory, directory, true, 'worker')).toMatchObject({
    source,
    name: 'worker',
    instructions: 'Winning instructions.',
  });
});

it('rejects an invalid named winner using the strict parser whitespace syntax', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-profile-whitespace-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const project = join(directory, '.pi', 'agents');
  mkdirSync(project, { recursive: true });
  const content = profile('Invalid winning instructions.')
    .replace('name: worker', 'name:\rworker')
    .replace('thinking: off', 'thinking: invalid');
  writeFileSync(join(project, 'custom.md'), content);

  expect(() => resolveProfile(directory, directory, true, 'worker')).toThrow(
    'Invalid profile thinking level.',
  );
});

it('validates only the requested winning profile and rejects malformed overrides', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-profile-selection-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const user = join(directory, 'agents');
  const project = join(directory, '.pi', 'agents');
  mkdirSync(user);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(user, 'unrelated.md'), 'Not a profile.');
  writeFileSync(join(user, 'renamed.md'), profile('Invalid overridden.').replace('editing', 'bad'));
  const winner = join(project, 'custom.md');
  writeFileSync(winner, profile('Chosen project instructions.'));
  const selected = () => resolveProfile(directory, directory, true, 'worker');

  expect(selected()).toMatchObject({
    name: 'worker',
    source: winner,
    instructions: 'Chosen project instructions.',
  });
  for (const content of [
    profile('Task').replace('editing', 'bad'),
    profile('Task').replace('thinking: off', 'thinking: invalid'),
    profile('Task').replace('thinking: off', 'tools: read'),
    '---\nname: worker\nrole: editing\nTask without closing frontmatter',
  ]) {
    writeFileSync(winner, content);
    expect(selected).toThrow(/Profile requires|Invalid profile|Unsupported/);
  }
  rmSync(winner);
  for (const content of [
    'Malformed winning profile.',
    '---\nname:\nrole: editing\n---\nTask',
    '---\nname: worker\nname: renamed\nrole: editing\n---\nTask',
  ]) {
    writeFileSync(join(project, 'worker.md'), content);
    expect(selected).toThrow(/Invalid profile|Unsupported|Malformed/);
  }
  writeFileSync(
    join(project, 'worker.md'),
    profile('Renamed instructions.').replace('name: worker', 'name: custom'),
  );
  expect(resolveProfile(directory, directory, true, 'custom')?.instructions).toBe(
    'Renamed instructions.',
  );
  expect(selected).toThrow('Profile requires');
  expect(resolveProfile(directory, directory, true, 'missing')).toBeUndefined();
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

  expect(resolveProfile(directory, directory, true, 'worker')?.instructions).toBe(
    'Project instructions.',
  );
  expect(resolveProfile(directory, directory, false, 'worker')?.instructions).toBe(
    'User instructions.',
  );
  expect(() =>
    parseProfile('---\nrole: editing\nsession-mode: fork\n---\nTask', 'worker', 'fixture'),
  ).toThrow('lineage-only');
  expect(() =>
    parseProfile('---\nrole: editing\ntools: read\n---\nTask', 'worker', 'fixture'),
  ).toThrow('Unsupported');
});
