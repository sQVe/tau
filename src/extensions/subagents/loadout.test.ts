import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { asPiLoadout, fixtureGenericLoadout, fixtureLoadout } from './fixtures/loadout.js';
import { checkWorkerRuntime, resolveLoadout, validateSavedLoadout } from './loadout.js';
import { resolveProfile, parseProfile } from './profiles.js';

const profile = (body: string) => `---\nname: worker\nrole: editing\nthinking: off\n---\n${body}`;

const startup =
  (...startupArguments: Parameters<typeof checkWorkerRuntime>) =>
  () => {
    checkWorkerRuntime(...startupArguments);
  };

const workerFixture = async (onTestFinished: (callback: () => void) => void) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tau-pi-loadout-')));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_SUBAGENT_MODEL', '');
  const provider = fauxProvider({ provider: 'tau-worker-fixture' });

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });

  runtime.registerNativeProvider(provider.provider);
  const model = provider.getModel();

  const context = {
    cwd: directory,
    modelRegistry: new ModelRegistry(runtime),
    scopedModels: [{ model }],
    isProjectTrusted: () => true,
  };

  const request = {
    profile: 'worker',
    permissions: 'trusted-full-tools',
    model: `${model.provider}/${model.id}`,
  };

  return { directory, model, context, request };
};

it('resolves an explicit worker model and names the configured models when none resolves', async ({
  onTestFinished,
}) => {
  const { directory, context, request } = await workerFixture(onTestFinished);

  const resolved = asPiLoadout(resolveLoadout(request, context));

  expect(resolved).toEqual({
    harness: 'pi',
    profile: 'worker',
    role: 'editing',
    model: request.model,
    thinking: 'off',
    cwd: directory,
    agentDirectory: directory,
    permissions: 'trusted-full-tools',
    instructions: resolved.instructions,
  });

  const withoutModel = { profile: 'worker', permissions: 'trusted-full-tools' };
  const missing = () => resolveLoadout(withoutModel, context);
  expect(missing).toThrow('no fallback');
  expect(missing).toThrow(`Configured models: ${request.model}.`);

  expect(() => resolveLoadout(withoutModel, { ...context, scopedModels: [] })).toThrow(
    /no fallback\.$/,
  );

  expect(() => resolveLoadout({ ...request, model: 'invalid model' }, context)).toThrow(
    'no fallback',
  );

  const unavailable = () => resolveLoadout({ ...request, model: 'missing/model' }, context);
  expect(unavailable).toThrow('unavailable: missing/model');
  expect(unavailable).toThrow(request.model);
  vi.stubEnv('TAU_SUBAGENT_MODEL', request.model);
  expect(asPiLoadout(resolveLoadout(withoutModel, context)).model).toBe(request.model);
  mkdirSync(join(directory, 'agents'));

  writeFileSync(
    join(directory, 'agents', 'worker.md'),
    profile('Custom task.').replace('role: editing', 'role: editing\nmodel: missing/profile'),
  );

  vi.stubEnv('TAU_SUBAGENT_MODEL', 'missing/environment');
  expect(() => resolveLoadout(withoutModel, context)).toThrow('missing/profile');
  expect(asPiLoadout(resolveLoadout(request, context)).model).toBe(request.model);

  expect(() => resolveLoadout({ ...request, harness: 'codex' }, context)).toThrow(
    'native-controls',
  );

  expect(() => resolveLoadout({ ...request, permissions: 'read-only' }, context)).toThrow(
    'trusted-full-tools',
  );

  expect(() => resolveLoadout(request, { ...context, isProjectTrusted: () => false })).toThrow(
    'trusted project',
  );

  const otherCwd = () => resolveLoadout({ ...request, cwd: tmpdir() }, context);
  expect(otherCwd).toThrow(context.cwd);
  expect(otherCwd).toThrow('herdr agent prompt');
  expect(() => resolveLoadout({ ...request, profile: 'missing' }, context)).toThrow('not found');
});

it('replays a saved loadout only under the same trust, directories, model, and thinking', async ({
  onTestFinished,
}) => {
  const { directory, context, request } = await workerFixture(onTestFinished);
  const saved = asPiLoadout(resolveLoadout(request, context));

  expect(validateSavedLoadout(saved, context)).toEqual(saved);

  expect(() => validateSavedLoadout({ ...saved, providerFingerprint: 'f' }, context)).toThrow(
    'Invalid saved',
  );

  expect(() => validateSavedLoadout(fixtureGenericLoadout(directory), context)).toThrow('Non-Pi');

  expect(() => validateSavedLoadout(saved, { ...context, isProjectTrusted: () => false })).toThrow(
    'trusted',
  );

  expect(() => validateSavedLoadout({ ...saved, cwd: join(directory, 'wrong') }, context)).toThrow(
    'cwd',
  );

  expect(() =>
    validateSavedLoadout({ ...saved, agentDirectory: join(directory, 'wrong') }, context),
  ).toThrow('directory');

  expect(() => validateSavedLoadout({ ...saved, model: 'missing/model' }, context)).toThrow(
    'no fallback',
  );

  expect(() => validateSavedLoadout({ ...saved, thinking: 'high' }, context)).toThrow('thinking');
});

it('refuses worker startup without the saved model, cwd, or CC Safety Net and activates the worker tools', async ({
  onTestFinished,
}) => {
  const { directory, model, request } = await workerFixture(onTestFinished);
  const loadout = { ...fixtureLoadout(directory), model: request.model };

  const safetyPath = join(
    dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
    'dist',
    'pi',
    'index.js',
  );

  const impostorPath = join(directory, 'cc-safety-net.js');
  writeFileSync(impostorPath, 'export default () => {};\n');
  const setActiveTools = vi.fn<ExtensionAPI['setActiveTools']>();

  const pi = {
    getThinkingLevel: () => 'off',
    getCommands: () => [
      { name: 'cc-safety-net:2', source: 'extension', sourceInfo: { path: safetyPath } },
    ],
    getAllTools: () => [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'ask_user_question', sourceInfo: { source: 'extension' } },
      { name: 'commit', sourceInfo: { source: 'extension' } },
    ],
    setActiveTools,
  } as unknown as Parameters<typeof checkWorkerRuntime>[1];

  const worker: Parameters<typeof checkWorkerRuntime>[2] = {
    model,
    cwd: directory,
    isProjectTrusted: () => true,
  };

  checkWorkerRuntime(loadout, pi, worker);

  expect(setActiveTools).toHaveBeenCalledWith([
    'read',
    'bash',
    'edit',
    'write',
    'commit',
    'subagent_progress',
    'subagent_report',
    'subagent_question',
  ]);

  expect(startup(loadout, pi, { ...worker, isProjectTrusted: () => false })).toThrow('trust');
  expect(startup(loadout, pi, { ...worker, model: undefined })).toThrow('no fallback');
  expect(startup({ ...loadout, model: 'other/model' }, pi, worker)).toThrow('no fallback');
  expect(startup({ ...loadout, thinking: 'high' }, pi, worker)).toThrow('no fallback');
  expect(startup({ ...loadout, cwd: join(directory, 'wrong') }, pi, worker)).toThrow('cwd');

  expect(
    startup(
      loadout,
      {
        ...pi,
        getCommands: () => [
          { name: 'cc-safety-net', source: 'skill', sourceInfo: { path: safetyPath } },
          { name: 'cc-safety-net', source: 'extension', sourceInfo: { path: impostorPath } },
        ],
      } as typeof pi,
      worker,
    ),
  ).toThrow('CC Safety Net');

  expect(setActiveTools).toHaveBeenCalledOnce();
});

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

// Loads real extensions from source, which can take several seconds on a busy CI runner.
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
