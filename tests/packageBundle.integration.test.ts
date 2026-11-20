import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { buildTauExtension } from '../scripts/buildTauExtension.js';
import { releaseRegistration } from '../src/inbox/inbox.js';
import tauRegistration from '../src/tau/tau.js';
import { readTauArtifactKey, tauArtifactPath } from '../src/tau/tauArtifact.js';
import { isTauRegistrationModule } from '../src/tau/tauSelection.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface NormalizedExtension {
  tools: [string, string][];
  commands: [string, string][];
  events: [string, number][];
  messageRenderers: string[];
  entryRenderers: string[];
  shortcuts: string[];
  flags: string[];
}

interface RpcResult {
  code: number | null;
  commands: string[];
  errors: string[];
  stderr: string;
}

// The registration trace records each hook, tool, and command in the order Tau registers it.
type Registration = [kind: string, name: string];

interface LoadedExtension {
  extensions: NormalizedExtension[];
  skills: { name: string; filePath: string }[];
}

interface RecordedRegistrations {
  calls: Registration[];
  sessionStart: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseEvent = (line: string): Record<string, unknown> | undefined => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  return isRecord(parsed) ? parsed : undefined;
};

const commandNames = (event: Record<string, unknown>): string[] => {
  const data = event.data;
  const commands = isRecord(data) ? data.commands : undefined;

  if (!Array.isArray(commands)) {
    return [];
  }

  return commands.flatMap((command) => {
    const name = isRecord(command) ? command.name : undefined;

    return typeof name === 'string' ? [name] : [];
  });
};

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

const sortedEntries = (entries: [string, unknown][]): [string, string][] =>
  entries
    .map(([name, value]): [string, string] => [name, String(value)])
    .toSorted(([first], [second]) => first.localeCompare(second));

const normalize = (loader: DefaultResourceLoader): NormalizedExtension[] => {
  const { extensions, errors, warnings } = loader.getExtensions();

  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);

  return extensions.map((extension) => ({
    tools: sortedEntries([...extension.tools].map(([name, tool]) => [name, tool.definition.name])),
    commands: sortedEntries(
      [...extension.commands].map(([name, command]) => [name, command.description]),
    ),
    // Handler order decides which guard runs first, so keep it.
    events: [...extension.handlers].map(([event, handlers]) => [event, handlers.length]),
    messageRenderers: [...extension.messageRenderers.keys()].toSorted(),
    entryRenderers: [...(extension.entryRenderers?.keys() ?? [])].toSorted((first, second) =>
      first.localeCompare(second),
    ),
    shortcuts: [...extension.shortcuts.keys()].toSorted(),
    flags: [...extension.flags.keys()].toSorted(),
  }));
};

const load = async (
  extensionPath: string,
  directory: string,
  skillPaths: readonly string[],
): Promise<LoadedExtension> => {
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, 'agent'),
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [extensionPath],
    additionalSkillPaths: [...skillPaths],
    noExtensions: true,
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
  });

  await loader.reload();

  const { skills } = loader.getSkills();

  return {
    extensions: normalize(loader),
    skills: skills.map((skill) => ({ name: skill.name, filePath: skill.filePath })),
  };
};

// The package names the skill directory Pi discovers, so the test reads the package's own
// configuration instead of inventing a path.
const configuredSkillDirectories = async (): Promise<string[]> => {
  const manifest: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const configured = isRecord(manifest) ? manifest['pi'] : undefined;
  const skills = isRecord(configured) ? configured['skills'] : undefined;

  if (!Array.isArray(skills) || skills.length === 0) {
    throw new Error('The package configures no skill paths.');
  }

  return skills.map((entry) => {
    if (typeof entry !== 'string') {
      throw new TypeError('A configured skill path is not a string.');
    }

    return resolvePath(packageRoot, entry);
  });
};

const isUnder = (filePath: string, directory: string): boolean => {
  const relativePath = relative(directory, filePath);

  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
};

const registeredCommandNames = (extensions: NormalizedExtension[]): string[] =>
  extensions.flatMap((extension) => extension.commands.map(([name]) => name)).toSorted();

// The language rule commands are the only commands Tau registers that are not skills.
const nonSkillCommandNames = new Set(['rust-rules', 'typescript-rules']);

const skillCommandNames = (extensions: NormalizedExtension[]): string[] =>
  registeredCommandNames(extensions).filter((name) => !nonSkillCommandNames.has(name));

// Pi wraps every handler in the same arrow function, so a registered handler list cannot show
// which handler runs first. The registration sequence can: each hook, tool, and command in the
// order Tau registers it. Two handlers of one event still look alike there, so the recorder names
// the identifiers each session_start handler reads, minus its parameters and the test runner's
// import wrapper. Those names survive the bundle's formatting, and reading them runs no handler.
const handlerParameters = new Set(['_event', 'context', 'event']);

const handlerIdentity = (handler: unknown): string => {
  const words = String(handler).match(/[A-Za-z_$][\w$]*/gu) ?? [];

  const free = words.filter(
    (word) => !handlerParameters.has(word) && !word.startsWith('__vite_ssr_'),
  );

  return [...new Set(free)].toSorted().join(',');
};

const recordingApi = (
  pi: ExtensionAPI,
  calls: Registration[],
  sessionStart: string[],
): ExtensionAPI =>
  new Proxy(pi, {
    get(target, name) {
      if (name === 'on') {
        const on = target.on as unknown as (event: string, handler: unknown) => unknown;

        return (event: string, handler: unknown) => {
          calls.push(['hook', event]);

          if (event === 'session_start') {
            sessionStart.push(handlerIdentity(handler));
          }

          return on.call(target, event, handler);
        };
      }

      if (name === 'registerTool') {
        const registerTool = target.registerTool as unknown as (tool: { name: string }) => unknown;

        return (tool: { name: string }) => {
          calls.push(['tool', tool.name]);

          return registerTool.call(target, tool);
        };
      }

      if (name === 'registerCommand') {
        const registerCommand = target.registerCommand as unknown as (
          commandName: string,
          command: unknown,
        ) => unknown;

        return (commandName: string, command: unknown) => {
          calls.push(['command', commandName]);

          return registerCommand.call(target, commandName, command);
        };
      }

      const properties = target as unknown as Record<PropertyKey, unknown>;
      const value = properties[name];

      if (typeof value !== 'function') {
        return value;
      }

      return value.bind(target) as unknown;
    },
  });

const artifactRegistration =
  (artifact: string): (() => Promise<ExtensionFactory>) =>
  async () => {
    const module: unknown = await import(pathToFileURL(artifact).href);

    if (!isTauRegistrationModule(module)) {
      throw new Error('The Tau artifact has no default registration.');
    }

    return module.default;
  };

const registeredHandlers = async (
  directory: string,
  registration: () => Promise<ExtensionFactory>,
): Promise<RecordedRegistrations> => {
  const calls: Registration[] = [];
  const sessionStart: string[] = [];

  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, 'agent'),
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [
      async (pi) => {
        const factory = await registration();

        await factory(recordingApi(pi, calls, sessionStart));
      },
    ],
    noExtensions: true,
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
  });

  await loader.reload();

  return { calls, sessionStart };
};

it('loads the same registrations, handler order, and skill commands from source and artifact', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-bundle-modes-');
  const artifact = await buildTauExtension(packageRoot);
  const skillDirectories = await configuredSkillDirectories();

  // Loading Tau claims the process-wide inbox, and no session runs to release it.
  onTestFinished(releaseRegistration);

  const fromSource = await load(
    join(packageRoot, 'src', 'tau', 'tau.ts'),
    directory,
    skillDirectories,
  );

  // Loading Tau claims the process-wide inbox slot, which the next load must be able to claim too.
  releaseRegistration();

  const fromArtifact = await load(artifact, directory, skillDirectories);

  expect(fromArtifact.extensions).toEqual(fromSource.extensions);
  // A skill command reads the file Pi discovers from the package manifest.
  expect(fromArtifact.skills).toEqual(fromSource.skills);
  expect(fromSource.skills.length).toBeGreaterThan(0);

  for (const skill of fromSource.skills) {
    const configured = skillDirectories.some((skillDirectory) =>
      isUnder(skill.filePath, skillDirectory),
    );

    expect(configured, skill.filePath).toBe(true);
  }

  const skillNames = fromSource.skills.map((skill) => skill.name).toSorted();

  // The first two session_start handlers must stay the lock and the warning reset, in that order.
  // Recording their identity shows the order without running either handler.
  const fromSourceHandlers = await registeredHandlers(directory, async () => tauRegistration);

  releaseRegistration();

  const fromArtifactHandlers = await registeredHandlers(directory, artifactRegistration(artifact));

  const sourceSessionStart = fromSourceHandlers.sessionStart.slice(0, 2);

  expect(sourceSessionStart).toEqual(['lockSessionOnStart', 'forgetReportedWarnings,ui']);

  expect(fromArtifactHandlers.sessionStart.slice(0, 2)).toEqual(sourceSessionStart);

  expect(skillCommandNames(fromSource.extensions)).toEqual(skillNames);
  expect(skillCommandNames(fromArtifact.extensions)).toEqual(skillNames);

  const commands = registeredCommandNames(fromArtifact.extensions);

  expect(commands).toContain('benchmark-checklist');
  expect(commands).toContain('tdd');
  expect(commands.length).toBeGreaterThan(20);
}, 120_000);

it('registers every hook, tool, and command in the same order from the bundle as from source', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-bundle-handlers-');
  const artifact = await buildTauExtension(packageRoot);

  onTestFinished(releaseRegistration);

  const sourceCalls = await registeredHandlers(directory, async () => tauRegistration);

  releaseRegistration();

  const artifactCalls = await registeredHandlers(directory, artifactRegistration(artifact));

  expect(sourceCalls.calls.length).toBeGreaterThan(20);
  expect(artifactCalls.calls).toEqual(sourceCalls.calls);
}, 120_000);

const writeSkillPathRecorder = async (directory: string): Promise<string> => {
  const record = join(directory, 'skill-paths.txt');
  // The recorder scripts sit outside the package, so they name Pi by its file URL.
  const piEntry = import.meta.resolve('@earendil-works/pi-coding-agent');

  await writeFile(
    join(directory, 'skill-hooks.mjs'),
    [
      "const recorder = new URL('./skill-recorder.mjs', import.meta.url).href;",
      '',
      'export async function resolve(specifier, context, nextResolve) {',
      "  const fromArtifact = context.parentURL?.endsWith('.mts') === true;",
      '',
      "  if (fromArtifact && specifier === '@earendil-works/pi-coding-agent') {",
      '    return { url: recorder, shortCircuit: true };',
      '  }',
      '',
      '  return nextResolve(specifier, context);',
      '}',
      '',
    ].join('\n'),
  );

  await writeFile(
    join(directory, 'skill-recorder.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      `import * as pi from ${JSON.stringify(piEntry)};`,
      '',
      `export * from ${JSON.stringify(piEntry)};`,
      '',
      'export const loadSkillsFromDir = (options) => {',
      "  appendFileSync(process.env['TAU_SKILL_RECORD'] ?? '', options.dir + '\\n');",
      '',
      '  return pi.loadSkillsFromDir(options);',
      '};',
      '',
    ].join('\n'),
  );

  await writeFile(
    join(directory, 'skill-register.mjs'),
    [
      "import { register } from 'node:module';",
      '',
      "register(new URL('./skill-hooks.mjs', import.meta.url));",
      '',
    ].join('\n'),
  );

  await writeFile(
    join(directory, 'skill-run.mjs'),
    [
      `import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(piEntry)};`,
      '',
      'const [extensionPath, directory] = process.argv.slice(2);',
      '',
      'const loader = new DefaultResourceLoader({',
      '  cwd: directory,',
      "  agentDir: directory + '/agent',",
      '  settingsManager: SettingsManager.inMemory(),',
      '  extensionFactories: [',
      '    async (pi) => {',
      '      const module = await import(extensionPath);',
      '',
      '      await module.default(pi);',
      '    },',
      '  ],',
      '  noExtensions: true,',
      '  noSkills: true,',
      '  noPromptTemplates: true,',
      '  noThemes: true,',
      '});',
      '',
      'await loader.reload();',
      '',
      'const { errors } = loader.getExtensions();',
      '',
      'if (errors.length > 0) {',
      '  process.stderr.write(JSON.stringify(errors));',
      '  process.exitCode = 1;',
      '}',
      '',
    ].join('\n'),
  );

  return record;
};

// The artifact resolves its skill catalog from its own module URL. The recorder wraps the loader
// the artifact imports, so it shows the directory the catalog read, not one the test supplies.
it('reads the package skill directory from the artifact', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-bundle-skill-path-');
  const artifact = await buildTauExtension(packageRoot);
  const record = await writeSkillPathRecorder(directory);

  await mkdir(join(directory, 'agent'), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(join(directory, 'skill-register.mjs')).href,
      join(directory, 'skill-run.mjs'),
      artifact,
      directory,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(directory, 'agent'),
        TAU_SKILL_RECORD: record,
      },
    },
  );

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);

  const recorded = (await readFile(record, 'utf8')).split('\n').filter((line) => line !== '');

  expect(recorded.map((path) => resolvePath(path))).toEqual(await configuredSkillDirectories());
}, 120_000);

it('rebases every source module URL in the artifact to a file in the package', async () => {
  const artifact = await buildTauExtension(packageRoot);
  const source = await readFile(artifact, 'utf8');

  const anchors = [...source.matchAll(/new URL\("([^"]+)", import\.meta\.url\)/gu)].map(
    (match) => match[1] ?? '',
  );

  expect(anchors.length).toBeGreaterThan(10);

  for (const anchor of anchors) {
    const resolved = fileURLToPath(new URL(anchor, pathToFileURL(artifact)));

    expect(resolved.startsWith(`${packageRoot}src/`), resolved).toBe(true);
    expect(existsSync(resolved), resolved).toBe(true);
  }
}, 120_000);

const copyPackage = async (target: string): Promise<void> => {
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']) {
    await cp(join(packageRoot, name), join(target, name));
  }

  for (const name of ['src', 'scripts', 'vendor']) {
    await cp(join(packageRoot, name), join(target, name), { recursive: true });
  }
};

// Pi installs a Git package with these flags, so no devDependency or Pi peer is installed.
const installProductionPackage = async (target: string, directory: string): Promise<void> => {
  const store = spawnSync('pnpm', ['store', 'path'], { encoding: 'utf8' }).stdout.trim();

  expect(store).not.toBe('');

  const result = spawnSync(
    'pnpm',
    [
      'install',
      '--prod',
      '--offline',
      '--frozen-lockfile',
      `--config.store-dir=${store}`,
      '--config.auto-install-peers=false',
      '--config.strict-peer-dependencies=false',
      '--config.strict-dep-builds=false',
    ],
    {
      cwd: target,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        HOME: process.env.HOME ?? '',
        PATH: process.env.PATH ?? '',
        TMPDIR: join(directory, 'tmp'),
        NODE_ENV: 'production',
        LC_ALL: 'C',
        TZ: 'UTC',
      },
    },
  );

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, `${target}\n${result.stdout}\n${result.stderr}`).toBe(0);
};

const askPiForCommands = async (target: string, directory: string): Promise<RpcResult> => {
  const home = join(directory, 'home');
  const agent = join(directory, 'agent');

  const child = spawn(
    process.execPath,
    [
      join(packageRoot, 'node_modules', '.bin', 'pi'),
      '--approve',
      '--mode',
      'rpc',
      '--no-session',
      '--no-extensions',
      '--no-themes',
      '--no-prompt-templates',
      '-e',
      target,
    ],
    {
      cwd: join(directory, 'cwd'),
      env: {
        HOME: home,
        PATH: process.env.PATH ?? '',
        TMPDIR: join(directory, 'tmp'),
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        PI_CODING_AGENT_DIR: agent,
        TAU_ROLE: 'worker',
        JITI_DEBUG: '1',
        LC_ALL: 'C',
        TZ: 'UTC',
      },
    },
  );

  let stderr = '';
  let commands: string[] = [];
  const errors: string[] = [];

  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });

  const reader = createInterface({ input: child.stdout });

  reader.on('line', (line) => {
    const event = parseEvent(line);

    if (event === undefined) {
      return;
    }

    if (event.type === 'extension_error') {
      errors.push(line);
    }

    if (event.id === 'probe') {
      commands = commandNames(event);
      child.stdin.end();
    }
  });

  child.stdin.write('{"id":"probe","type":"get_commands"}\n');

  const code = await new Promise<number | null>((resolve) => {
    child.on('close', (value) => {
      resolve(value);
    });
  });

  return { code, commands, errors, stderr };
};

it('loads the artifact from a relocated production-only install through the packaged CLI', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-bundle-install-');
  const target = join(directory, 'package');

  for (const name of ['cwd', 'home', 'agent', 'tmp']) {
    await mkdir(join(directory, name), { recursive: true });
  }

  await mkdir(target, { recursive: true });
  await copyPackage(target);
  await installProductionPackage(target, directory);

  // Pi installs from Git without peer packages, so the artifact must resolve Pi's modules itself.
  for (const name of ['@earendil-works', 'typebox']) {
    await rm(join(target, 'node_modules', name), { recursive: true, force: true });
  }

  expect(existsSync(join(target, 'node_modules', '@earendil-works'))).toBe(false);
  expect(existsSync(join(target, 'node_modules', '@stryker-mutator'))).toBe(false);

  const key = await readTauArtifactKey(target);
  const artifact = tauArtifactPath(target, key);

  expect(existsSync(artifact)).toBe(true);

  const result = await askPiForCommands(target, directory);

  expect(result.errors).toEqual([]);
  expect(result.code).toBe(0);
  expect(result.commands).toContain('benchmark-checklist');
  expect(result.commands).toContain('tdd');
  expect(result.commands.length).toBeGreaterThan(40);
  // The selection must reach the artifact rather than fall back to the source entry.
  expect(result.stderr).toContain(artifact);
}, 180_000);
