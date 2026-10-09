import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, SlashCommandInfo } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { fixtureLoadout } from './fixtures/loadout.js';
import {
  checkWorkerRuntime,
  resolveLoadout,
  resolveRoutedLoadout,
  validateSavedLoadout,
} from './loadout.js';
import { listProfiles, resolveProfile, parseProfile } from './profiles.js';

const profile = (body: string) => `---\nname: worker\nrole: editing\nthinking: off\n---\n${body}`;

const skillCommand = (name: string, path: string) =>
  ({ name: `skill:${name}`, source: 'skill', sourceInfo: { path } }) as SlashCommandInfo;

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

  const request = { profile: 'worker', model: `${model.provider}/${model.id}` };

  return { directory, model, context, request };
};

it('resolves an explicit worker model and names the configured models when none resolves', async ({
  onTestFinished,
}) => {
  const { directory, context, request } = await workerFixture(onTestFinished);

  const resolved = resolveLoadout(request, context);

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
    tools: resolved.tools,
    skills: [],
    instructionSets: ['writing', 'coding', 'workflow'],
    packages: [],
  });

  writeFileSync(
    join(directory, 'tau.json'),
    JSON.stringify({ profiles: { default: { model: 'missing/model' } } }),
  );

  const unavailableDefault = () => resolveLoadout({ profile: 'worker' }, context);
  expect(unavailableDefault).toThrow('unavailable: missing/model');
  expect(unavailableDefault).toThrow(`Configured models: ${request.model}.`);

  expect(() => resolveLoadout({ profile: 'worker' }, { ...context, scopedModels: [] })).toThrow(
    /unavailable: missing\/model\.$/,
  );

  expect(() => resolveLoadout({ ...request, model: 'invalid model' }, context)).toThrow(
    'no fallback',
  );

  const unavailable = () => resolveLoadout({ ...request, model: 'missing/model' }, context);
  expect(unavailable).toThrow('unavailable: missing/model');
  expect(unavailable).toThrow(request.model);
  expect(resolveLoadout(request, context).model).toBe(request.model);

  expect(() => resolveLoadout(request, { ...context, isProjectTrusted: () => false })).toThrow(
    'trusted project',
  );

  const otherCwd = () => resolveLoadout({ ...request, cwd: tmpdir() }, context);
  expect(otherCwd).toThrow(context.cwd);
  expect(otherCwd).toThrow('herdr agent prompt');
  expect(() => resolveLoadout({ ...request, profile: 'missing' }, context)).toThrow('not found');
});

const writeConfig = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

const bundledFixture = async (onTestFinished: (callback: () => void) => void) => {
  const fixture = await workerFixture(onTestFinished);
  const bundled = fauxProvider({ provider: 'claude-bridge', models: [{ id: 'claude-opus-5-5' }] });

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });

  runtime.registerNativeProvider(bundled.provider);
  runtime.registerNativeProvider(fauxProvider({ provider: 'tau-worker-fixture' }).provider);
  const context = { ...fixture.context, modelRegistry: new ModelRegistry(runtime) };

  return { ...fixture, context, opus: bundled.getModel() };
};

it('refuses to launch a bundled profile without a launch or configured model', async ({
  onTestFinished,
}) => {
  const { directory, context, request } = await bundledFixture(onTestFinished);
  const userFile = join(directory, 'tau.json');

  writeConfig(userFile, { profiles: { scout: { model: request.model } } });

  for (const name of ['worker', 'reviewer', 'qa']) {
    const missing = () => resolveLoadout({ profile: name }, context);
    expect(missing).toThrow(`profiles.default.model in ${userFile}`);
    expect(missing).toThrow(`Configured models: ${request.model}.`);
  }

  expect(resolveLoadout({ profile: 'scout' }, context).model).toBe(request.model);
  expect(resolveLoadout(request, context).model).toBe(request.model);
});

it('selects the launch model, then the profile entry, then the default entry', async ({
  onTestFinished,
}) => {
  const { directory, context, request } = await bundledFixture(onTestFinished);
  const opus = 'claude-bridge/claude-opus-5-5';

  writeConfig(join(directory, 'tau.json'), {
    profiles: { scout: { model: request.model }, default: { model: opus } },
  });

  expect(resolveLoadout({ profile: 'scout' }, context).model).toBe(request.model);
  expect(resolveLoadout({ profile: 'worker' }, context).model).toBe(opus);
  expect(resolveLoadout({ profile: 'scout', model: opus }, context).model).toBe(opus);

  writeConfig(join(directory, 'tau.json'), { profiles: { default: { model: request.model } } });

  expect(resolveLoadout({ profile: 'reviewer' }, context).model).toBe(request.model);
});

it('refuses a configured profile model that is unavailable or malformed', async ({
  onTestFinished,
}) => {
  const { directory, context, request } = await bundledFixture(onTestFinished);
  const userFile = join(directory, 'tau.json');

  writeConfig(userFile, { profiles: { worker: { model: 'missing/model' } } });

  const unavailable = () => resolveLoadout({ profile: 'worker' }, context);
  expect(unavailable).toThrow('unavailable: missing/model');
  expect(unavailable).toThrow(request.model);

  writeConfig(userFile, { profiles: { worker: { model: 'no-provider' } } });

  for (const launch of [{ profile: 'worker' }, request]) {
    const malformed = () => resolveLoadout(launch, context);
    expect(malformed).toThrow(userFile);
    expect(malformed).toThrow('profiles.worker.model');
  }
});

it('refuses launch when the repository config sets profiles', async ({ onTestFinished }) => {
  const { directory, context, request } = await bundledFixture(onTestFinished);
  const repositoryFile = join(directory, '.pi', 'tau.json');

  writeConfig(repositoryFile, { profiles: { worker: { model: request.model } } });

  expect(() => resolveLoadout({ profile: 'worker' }, context)).toThrow(repositoryFile);
  expect(() => resolveLoadout(request, context)).toThrow(repositoryFile);
});

it('checks only the selected model against allowedModels', async ({ onTestFinished }) => {
  const { directory, context, request } = await bundledFixture(onTestFinished);
  const repositoryFile = join(directory, '.pi', 'tau.json');

  writeConfig(join(directory, 'tau.json'), {
    allowedModels: ['claude-bridge/claude-opus-5-5', request.model],
    profiles: { default: { model: 'claude-bridge/claude-opus-5-5' } },
  });

  writeConfig(repositoryFile, { allowedModels: [request.model] });

  const disallowedDefault = () => resolveLoadout({ profile: 'worker' }, context);
  expect(disallowedDefault).toThrow('claude-bridge/claude-opus-5-5');
  expect(disallowedDefault).toThrow(repositoryFile);
  expect(resolveLoadout(request, context).model).toBe(request.model);
});

it('names only the allowed scoped models when a launch model is unavailable', async ({
  onTestFinished,
}) => {
  const { directory, context, request, opus } = await bundledFixture(onTestFinished);
  const scoped = { ...context, scopedModels: [...context.scopedModels, { model: opus }] };

  writeConfig(join(directory, 'tau.json'), { allowedModels: ['claude-bridge/claude-opus-5-5'] });

  const invalid = () => resolveLoadout({ ...request, model: 'invalid model' }, scoped);
  expect(invalid).toThrow('Configured models: claude-bridge/claude-opus-5-5.');
});

it('refuses profile files that set a model or use the reserved default name', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-profile-model-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'agents'));
  const withModel = join(directory, 'agents', 'worker.md');
  const named = join(directory, 'agents', 'reserved.md');

  writeFileSync(withModel, profile('Task.').replace('thinking: off', 'model: a/model'));
  writeFileSync(named, profile('Task.').replace('name: worker', 'name: default'));

  const modelProfile = () => resolveProfile(directory, directory, false, 'worker');
  expect(modelProfile).toThrow(withModel);
  expect(modelProfile).toThrow('tau.json');
  expect(() => resolveProfile(directory, directory, false, 'default')).toThrow(named);
});

it('resolves and replays a worker model whose ID contains a slash', async ({ onTestFinished }) => {
  const { context, request } = await workerFixture(onTestFinished);
  const nested = fauxProvider({ provider: 'openrouter', models: [{ id: 'meta/llama' }] });

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });

  runtime.registerNativeProvider(nested.provider);
  const withNested = { ...context, modelRegistry: new ModelRegistry(runtime) };
  const launch = { ...request, model: 'openrouter/meta/llama' };
  const saved = resolveLoadout(launch, withNested);

  expect(saved.model).toBe('openrouter/meta/llama');
  expect(validateSavedLoadout(saved, withNested)).toEqual(saved);
});

it('replays a saved loadout only under the same trust, directories, model, and thinking', async ({
  onTestFinished,
}) => {
  const { directory, context, request } = await workerFixture(onTestFinished);
  const saved = resolveLoadout(request, context);

  expect(validateSavedLoadout(saved, context)).toEqual(saved);

  expect(() => validateSavedLoadout({ ...saved, providerFingerprint: 'f' }, context)).toThrow(
    'Invalid saved',
  );

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

  const skill = join(directory, 'skills', 'SKILL.md');

  expect(() => validateSavedLoadout({ ...saved, skills: [skill] }, context)).toThrow(
    `skill is missing: ${skill}`,
  );
});

const allowModels = (path: string, allowedModels: string[] | undefined) => {
  if (allowedModels !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ allowedModels }));
  }
};

const allowedFixture = async (
  onTestFinished: (callback: () => void) => void,
  user: string[] | undefined,
  repository: string[] | undefined,
) => {
  const { directory, context, request } = await workerFixture(onTestFinished);
  const saved = resolveLoadout(request, context);

  const entries = (models?: string[]) =>
    models?.map((model) => model.replace('{model}', request.model));

  allowModels(join(directory, 'tau.json'), entries(user));
  allowModels(join(directory, '.pi', 'tau.json'), entries(repository));

  return { directory, context, request, saved };
};

it.for<[string, string[] | undefined, string[] | undefined]>([
  ['an absent list', undefined, undefined],
  ['an allowed model', ['{model}', 'other/model'], undefined],
  ['a repository list that narrows', ['{model}', 'other/model'], ['{model}']],
])(
  'launches and replays workers under allowedModels: %s',
  async ([, user, repository], { onTestFinished }) => {
    const { context, request, saved } = await allowedFixture(onTestFinished, user, repository);

    expect(resolveLoadout(request, context).model).toBe(request.model);
    expect(validateSavedLoadout(saved, context)).toEqual(saved);
  },
);

it.for<[string, string[] | undefined, string[] | undefined, string]>([
  ['a model outside the user list', ['other/model'], undefined, 'tau.json'],
  [
    'a model the repository list removes',
    ['{model}', 'other/model'],
    ['other/model'],
    '.pi/tau.json',
  ],
  [
    'a repository list that tries to widen',
    ['other/model'],
    ['other/model', '{model}'],
    '.pi/tau.json',
  ],
])(
  'refuses to launch or replay workers under allowedModels: %s',
  async ([, user, repository, refusingFile], { onTestFinished }) => {
    const { directory, context, request, saved } = await allowedFixture(
      onTestFinished,
      user,
      repository,
    );

    for (const refused of [
      () => resolveLoadout(request, context),
      () => validateSavedLoadout(saved, context),
    ]) {
      expect(refused).toThrow(request.model);
      expect(refused).toThrow('other/model');
      expect(refused).toThrow(join(directory, refusingFile));
    }
  },
);

it('refuses worker startup without the saved model, cwd, CC Safety Net, or profile tools and activates only those tools', async ({
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
    getAllTools: () =>
      [
        'read',
        'bash',
        'edit',
        'write',
        'ask_user_question',
        'subagent_progress',
        'subagent_report',
        'subagent_question',
      ].map((name) => ({ name })),
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
    'subagent_progress',
    'subagent_report',
    'subagent_question',
  ]);

  const unregistered = startup({ ...loadout, tools: ['read', 'web_search', 'commit'] }, pi, worker);
  expect(unregistered).toThrow('web_search, commit');

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

  const withSkill = { ...loadout, skills: ['/skills/tracker/SKILL.md'] };

  expect(startup(withSkill, pi, worker)).toThrow('tracker_evidence');
  expect(setActiveTools).toHaveBeenCalledOnce();

  checkWorkerRuntime(
    withSkill,
    {
      ...pi,
      getAllTools: () => [...pi.getAllTools(), { name: 'tracker_evidence' }],
    } as typeof pi,
    worker,
  );

  expect(setActiveTools).toHaveBeenLastCalledWith([
    'read',
    'bash',
    'edit',
    'write',
    'subagent_progress',
    'subagent_report',
    'subagent_question',
    'tracker_evidence',
  ]);
});

it.for(['reviewer', 'qa'])(
  'launches the bundled %s without editing responsibility',
  async (name, { onTestFinished }) => {
    const { context, request } = await workerFixture(onTestFinished);

    expect(resolveLoadout({ ...request, profile: name }, context)).toMatchObject({
      profile: name,
      role: 'investigation',
    });
  },
);

it('saves the profile tools, or the role defaults, and the paths of its skills', async ({
  onTestFinished,
}) => {
  const { directory, context, request } = await workerFixture(onTestFinished);
  mkdirSync(join(directory, 'agents'));

  const saveProfile = (name: string, settings: string) => {
    writeFileSync(
      join(directory, 'agents', `${name}.md`),
      `---\nname: ${name}\nrole: investigation\n${settings}---\nInspect.\n`,
    );
  };

  saveProfile('narrow', 'tools: read, web_search, read\nskills: code-review\n');
  saveProfile('plain', '');
  saveProfile('unknown', 'skills: code-review, missing-skill\n');

  const commands = [
    { name: 'skill:code-review', source: 'extension', sourceInfo: { path: '/extension.ts' } },
    skillCommand('code-review', '/skills/code-review/SKILL.md'),
  ] as SlashCommandInfo[];

  const resolve = (name: string) =>
    resolveLoadout({ ...request, profile: name }, context, commands);

  expect(resolve('narrow')).toMatchObject({
    tools: ['read', 'web_search'],
    skills: ['/skills/code-review/SKILL.md'],
  });

  expect(resolve('plain')).toMatchObject({ tools: ['read', 'bash'], skills: [] });
  expect(() => resolve('unknown')).toThrow('Worker profile skill not found: missing-skill');
});

const parseSettings = (settings: string) =>
  parseProfile(`---\nrole: investigation\n${settings}---\nInspect.\n`, 'custom', 'fixture');

it('saves the profile instruction sets, or all but browser without the setting', async ({
  onTestFinished,
}) => {
  const { context, request } = await workerFixture(onTestFinished);
  const resolve = (name: string) => resolveLoadout({ ...request, profile: name }, context);

  expect(parseSettings('instruction-sets: workflow, writing, workflow\n').instructionSets).toEqual([
    'workflow',
    'writing',
  ]);

  expect(parseSettings('').instructionSets).toEqual(['writing', 'coding', 'workflow']);
  expect(resolve('scout').instructionSets).toEqual(['writing', 'workflow']);
  expect(resolve('qa').instructionSets).toEqual(['writing', 'workflow', 'browser']);
  expect(resolve('browser').instructionSets).toEqual(['writing', 'workflow', 'browser']);
  expect(resolve('reviewer').instructionSets).toEqual(['writing', 'coding', 'workflow']);
  expect(resolve('worker').instructionSets).toEqual(['writing', 'coding', 'workflow']);
});

it('rejects an unknown or empty profile instruction set', () => {
  expect(() => parseSettings('instruction-sets: writing, testing\n')).toThrow(
    'Unknown profile instruction set: testing',
  );

  expect(() => parseSettings('instruction-sets: writing,,coding\n')).toThrow(
    'comma-separated list',
  );
});

it('defaults bundled roles to medium effort without effort settings in markdown', () => {
  for (const name of ['scout', 'worker', 'reviewer', 'qa', 'browser']) {
    const source = new URL(`./profiles/${name}.md`, import.meta.url);
    const content = readFileSync(source, 'utf8');

    expect(content).not.toMatch(/^(?:thinking|effort):/m);

    expect(parseProfile(content, name, source.pathname)).toMatchObject({
      name,
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

const withCli = (cli: string) => `---\nrole: editing\ncli: ${cli}\n---\nTask`;

it('refuses a profile whose cli is not Pi', () => {
  expect(parseProfile(withCli('pi'), 'worker', 'fixture')).toMatchObject({ name: 'worker' });

  for (const cli of ['claude', 'codex']) {
    expect(() => parseProfile(withCli(cli), 'worker', 'fixture')).toThrow(
      'non-Pi workers are no longer supported',
    );
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
    profile('Task').replace('thinking: off', 'tools: read, web search'),
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

it('lists bundled, user, and trusted project profiles without changing profile files', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-profile-list-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const description: unknown = expect.any(String);

  const bundled = [
    { name: 'browser', description },
    { name: 'qa', description },
    ...['reviewer', 'scout', 'worker'].map((name) => ({ name })),
  ];

  expect(listProfiles(directory, directory, true)).toEqual(bundled);

  const user = join(directory, 'agents');
  const project = join(directory, '.pi', 'agents');
  mkdirSync(user);
  mkdirSync(project, { recursive: true });

  writeFileSync(
    join(user, 'triage.md'),
    profile('Triage.').replace('name: worker', 'name: triage\ndescription: Sorts bug reports'),
  );

  writeFileSync(join(user, 'broken.md'), 'Not a profile.');

  writeFileSync(
    join(project, 'worker.md'),
    profile('Project worker.').replace('role:', 'description: Project editor\nrole:'),
  );

  const files = () =>
    [user, project].flatMap((folder) =>
      readdirSync(folder)
        .toSorted()
        .map((name) => [name, readFileSync(join(folder, name), 'utf8')]),
    );

  const before = files();

  expect(listProfiles(directory, directory, true)).toEqual([
    { name: 'browser', description },
    { name: 'qa', description },
    { name: 'reviewer' },
    { name: 'scout' },
    { name: 'worker', description: 'Project editor' },
    { name: 'broken' },
    { name: 'triage', description: 'Sorts bug reports' },
  ]);

  expect(listProfiles(directory, directory, false)).toEqual([
    ...bundled,
    { name: 'broken' },
    { name: 'triage', description: 'Sorts bug reports' },
  ]);

  expect(files()).toEqual(before);
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

  for (const setting of [
    'session-mode: lineage-only',
    'permissions: trusted-full-tools',
    'extensions: none',
  ]) {
    expect(() =>
      parseProfile(`---\nrole: editing\n${setting}\n---\nTask`, 'worker', 'fixture'),
    ).toThrow('Unsupported');
  }
});

it('saves the profile packages, or none without the setting', async ({ onTestFinished }) => {
  const { context, request } = await workerFixture(onTestFinished);
  const resolve = (name: string) => resolveLoadout({ ...request, profile: name }, context);

  expect(
    parseSettings('packages: npm:pi-codex-image-gen@1.2.3, ./probe, npm:pi-codex-image-gen@1.2.3\n')
      .packages,
  ).toEqual(['npm:pi-codex-image-gen@1.2.3', './probe']);

  expect(parseSettings('').packages).toEqual([]);
  expect(resolve('qa').packages).toEqual(['npm:pi-agent-browser-native@0.9.3']);
  expect(resolve('worker').packages).toEqual([]);
});

it('rejects an empty profile package', () => {
  expect(() => parseSettings('packages: npm:pi-codex-image-gen, \n')).toThrow(
    'comma-separated list',
  );
});

const haiku = 'tau-worker-fixture/haiku';

const answered = (label: string, confidence: number) => ({
  stopReason: 'stop',
  answers: { route: { type: 'choice', choice: label, probabilities: {}, confidence } },
});

const routedFixture = async (onTestFinished: (callback: () => void) => void) => {
  const fixture = await workerFixture(onTestFinished);
  const { directory, model } = fixture;
  const profileModel = `${model.provider}/${model.id}`;

  const routes = {
    question: 'How wide is this brief?',
    labels: {
      narrow: { criterion: 'A lookup about known code.', model: haiku },
      wide: { criterion: 'An investigation across many files.', model: profileModel },
    },
  };

  writeFileSync(
    join(directory, 'tau.json'),
    JSON.stringify({
      profiles: {
        scout: { model: profileModel, routes },
        worker: { model: profileModel, routes },
        reviewer: { model: profileModel },
      },
    }),
  );

  const classify = vi.fn<(...parameters: unknown[]) => Promise<unknown>>();
  const hasClassifier = { value: true };

  const registry = Object.assign(Object.create(fixture.context.modelRegistry) as ModelRegistry, {
    findOfType: () => (hasClassifier.value ? { id: 'jev-latest' } : undefined),
    classify,
  });

  const context = { ...fixture.context, modelRegistry: registry };

  return { ...fixture, context, classify, hasClassifier, profileModel };
};

it('records the shadow pick of a scout launch and keeps the profile model', async ({
  onTestFinished,
}) => {
  const { context, classify, profileModel } = await routedFixture(onTestFinished);
  classify.mockResolvedValue(answered('narrow', 0.9));

  const { loadout, routing } = await resolveRoutedLoadout(
    { profile: 'scout', task: 'Find the parser.' },
    context,
  );

  expect(loadout.model).toBe(profileModel);
  expect(routing).toEqual({ shadowPick: haiku, label: 'narrow', confidence: 0.9 });
  expect(classify).toHaveBeenCalledOnce();

  expect(classify.mock.calls[0]?.[1]).toMatchObject({
    state: { brief: 'Find the parser.', profile: 'scout' },
    questions: {
      route: {
        type: 'choice',
        instructions: 'How wide is this brief?',
        criteria: {
          narrow: 'A lookup about known code.',
          wide: 'An investigation across many files.',
        },
      },
    },
  });
});

it('classifies nothing and records no routing when the launch names a model', async ({
  onTestFinished,
}) => {
  const { context, classify, request } = await routedFixture(onTestFinished);

  const result = await resolveRoutedLoadout({ ...request, task: 'Edit the parser.' }, context);

  expect(result.routing).toBeUndefined();
  expect(classify).not.toHaveBeenCalled();
});

it('classifies nothing for a profile without routes', async ({ onTestFinished }) => {
  const { context, classify } = await routedFixture(onTestFinished);

  const result = await resolveRoutedLoadout({ profile: 'reviewer', task: 'Review.' }, context);

  expect(result.routing).toBeUndefined();
  expect(classify).not.toHaveBeenCalled();
});

it.for([
  ['an error result', () => Promise.resolve({ stopReason: 'error', answers: {} })],
  ['a rejection', () => Promise.reject(new Error('offline'))],
] as const)('launches on the profile model after %s', async ([, outcome], { onTestFinished }) => {
  const { context, classify, profileModel } = await routedFixture(onTestFinished);
  classify.mockImplementation(outcome);

  const { loadout, routing } = await resolveRoutedLoadout(
    { profile: 'worker', task: 'Fix it.' },
    context,
  );

  expect(loadout.model).toBe(profileModel);
  expect(routing).toEqual({ shadowPick: profileModel, fallbackReason: 'error' });
});

it('launches on the profile model when the classifier never answers within 5 seconds', async ({
  onTestFinished,
}) => {
  const { context, classify, profileModel } = await routedFixture(onTestFinished);
  vi.useFakeTimers();

  onTestFinished(() => {
    vi.useRealTimers();
  });

  classify.mockImplementation(() => new Promise(() => {}));

  const pending = resolveRoutedLoadout({ profile: 'scout', task: 'Find it.' }, context);
  const settled = vi.fn<() => void>();
  const finished = pending.then(settled);

  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await finished;
  const { loadout, routing } = await pending;

  expect(loadout.model).toBe(profileModel);
  expect(routing).toEqual({ shadowPick: profileModel, fallbackReason: 'timeout' });

  const options = classify.mock.calls[0]?.[2] as { signal: AbortSignal };
  expect(options.signal.aborted).toBe(true);
});

it('classifies nothing when allowedModels excludes the classifier', async ({ onTestFinished }) => {
  const { directory, context, classify, profileModel } = await routedFixture(onTestFinished);
  const configPath = join(directory, 'tau.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;

  writeFileSync(configPath, JSON.stringify({ ...config, allowedModels: [profileModel, haiku] }));
  classify.mockResolvedValue(answered('narrow', 0.9));

  const { loadout, routing } = await resolveRoutedLoadout(
    { profile: 'scout', task: 'Find it.' },
    context,
  );

  expect(loadout.model).toBe(profileModel);
  expect(routing).toEqual({ shadowPick: profileModel, fallbackReason: 'noRoute' });
  expect(classify).not.toHaveBeenCalled();
});

it('records a low confidence answer and a missing classifier model as fallbacks', async ({
  onTestFinished,
}) => {
  const { context, classify, hasClassifier, profileModel } = await routedFixture(onTestFinished);

  classify.mockResolvedValue(answered('narrow', 0.5));
  const brief = { profile: 'scout', task: 'Find it.' };

  expect((await resolveRoutedLoadout(brief, context)).routing).toEqual({
    shadowPick: profileModel,
    label: 'narrow',
    confidence: 0.5,
    fallbackReason: 'lowConfidence',
  });

  classify.mockClear();
  hasClassifier.value = false;

  expect((await resolveRoutedLoadout(brief, context)).routing).toEqual({
    shadowPick: profileModel,
    fallbackReason: 'noRoute',
  });

  expect(classify).not.toHaveBeenCalled();
});
