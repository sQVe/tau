import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@mariozechner/pi-ai';
import type { FauxProviderRegistration } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createCodingTools,
} from '@mariozechner/pi-coding-agent';
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUIContext,
} from '@mariozechner/pi-coding-agent';
import type { TestContext } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

// Each test boots a pi session and runs real git, so the 5s default is too tight for slow CI.
vi.setConfig({ testTimeout: 60_000 });

// Taken from the per-test context so cleanup stays scoped to its own test,
// including when the suite runs concurrently.
type RegisterCleanup = TestContext['onTestFinished'];

const execFileAsync = promisify(execFile);

const tauExtensionsPath = resolve(import.meta.dirname, '..');

let harnessCounter = 0;

interface Harness {
  session: AgentSession;
  faux: FauxProviderRegistration;
  repoDir: string;
  events: AgentSessionEvent[];
  overlays: string[];
  commandNames: string[];
}

// The developer's global git config must not reach the fixture; a global
// core.hooksPath would otherwise run real hooks on every fixture commit.
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const git = async (repoDir: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, { cwd: repoDir, env: gitEnvironment });
  return stdout;
};

const createTempDir = async (registerCleanup: RegisterCleanup, prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const createTempRepo = async (registerCleanup: RegisterCleanup): Promise<string> => {
  const repoDir = await createTempDir(registerCleanup, 'tau-flow-repo-');

  await git(repoDir, ['init', '--initial-branch=main']);
  await git(repoDir, ['config', 'user.email', 'tau@example.com']);
  await git(repoDir, ['config', 'user.name', 'Tau Test']);
  await git(repoDir, ['config', 'commit.gpgsign', 'false']);
  // pi runs git itself, so the hook opt-out has to live in the repo config too.
  await git(repoDir, ['config', 'core.hooksPath', join(repoDir, '.no-hooks')]);
  await writeFile(join(repoDir, 'README.md'), '# fixture\n', 'utf8');
  await git(repoDir, ['add', 'README.md']);
  await git(repoDir, ['commit', '-m', 'chore: initial commit']);

  return repoDir;
};

// Any object other than pi's module-private noOpUIContext flips ctx.hasUI to true.
// Only the methods tau actually calls need real behavior. The overlay factory is
// rendered once so the test can assert on what the user would have seen.
const createScriptedUI = (overlays: string[], answer: boolean): ExtensionUIContext => {
  const target: Record<string | symbol, unknown> = {
    custom: async (factory: Parameters<ExtensionUIContext['custom']>[0]) => {
      const component = await factory(
        { requestRender: () => {}, terminal: { rows: 60 } } as never,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
        {} as never,
        () => {},
      );
      overlays.push(component.render(80).join('\n'));
      return answer ? 'approve' : 'abort';
    },
  };

  // Fail loudly rather than answering undefined: a UI method this stub does not
  // script means the test is asserting a path it never actually exercised.
  const scriptedUI = new Proxy(target, {
    get: (object, property) => {
      if (property in object) {
        return object[property];
      }

      throw new Error(`Scripted UI has no ${String(property)}`);
    },
  });

  return scriptedUI as unknown as ExtensionUIContext;
};

const createHarness = async (
  registerCleanup: RegisterCleanup,
  options: { confirmAnswer?: boolean | null } = {},
): Promise<Harness> => {
  const repoDir = await createTempRepo(registerCleanup);
  const agentDir = await createTempDir(registerCleanup, 'tau-flow-agent-');

  // The provider registry is a module-level singleton, so each harness needs its own name.
  harnessCounter += 1;
  const fauxProviderName = `tau-test-${harnessCounter}`;
  const faux = registerFauxProvider({ provider: fauxProviderName });
  registerCleanup(() => {
    faux.unregister();
  });

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: repoDir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [tauExtensionsPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  // The faux provider ignores the key, but the session refuses to prompt without one.
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(fauxProviderName, 'faux-key');

  const { session, extensionsResult } = await createAgentSession({
    cwd: repoDir,
    agentDir,
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(repoDir),
    settingsManager,
    tools: createCodingTools(repoDir),
  });
  registerCleanup(() => {
    session.dispose();
  });

  expect(extensionsResult.errors).toEqual([]);

  const overlays: string[] = [];
  const { confirmAnswer = true } = options;
  await session.bindExtensions(
    confirmAnswer === null ? {} : { uiContext: createScriptedUI(overlays, confirmAnswer) },
  );

  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });

  const commandNames = extensionsResult.extensions.flatMap((extension) =>
    Array.from(extension.commands.keys()),
  );

  return { session, faux, repoDir, events, overlays, commandNames };
};

const toolResultOf = (events: AgentSessionEvent[], toolName: string) => {
  const end = events.find(
    (event) => event.type === 'tool_execution_end' && event.toolName === toolName,
  );

  if (end?.type !== 'tool_execution_end') {
    throw new Error(`No tool_execution_end event for ${toolName}`);
  }

  return end;
};

describe('commit flow', () => {
  it('registers the commit tool and command in a real pi session', async ({ onTestFinished }) => {
    const { session, commandNames } = await createHarness(onTestFinished);

    expect(session.agent.state.tools.map((tool) => tool.name)).toContain('commit');
    expect(commandNames).toContain('commit');
  });

  it('commits through the commit tool when the user confirms', async ({ onTestFinished }) => {
    const { session, faux, repoDir, events, overlays } = await createHarness(onTestFinished);

    await writeFile(join(repoDir, 'feature.txt'), 'hello\n', 'utf8');
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          files: ['feature.txt'],
          subject: 'feat: add feature file',
          body: 'Prove the commit tool runs end to end.',
        }),
      ]),
      fauxAssistantMessage('Committed.'),
    ]);

    await session.prompt('Commit the new file.');

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toContain('feat: add feature file');
    expect(overlays[0]).toContain('feature.txt +1 -0');

    const result = toolResultOf(events, 'commit');
    expect(result.isError).toBe(false);

    const log = await git(repoDir, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe('feat: add feature file');
  });

  it('does not commit when the user declines', async ({ onTestFinished }) => {
    const { session, faux, repoDir, events, overlays } = await createHarness(onTestFinished, {
      confirmAnswer: false,
    });

    await writeFile(join(repoDir, 'feature.txt'), 'hello\n', 'utf8');
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', { files: ['feature.txt'], subject: 'feat: add feature file' }),
      ]),
      fauxAssistantMessage('Declined.'),
    ]);

    await session.prompt('Commit the new file.');

    // The overlay must have been reached and answered, not skipped by an earlier failure.
    expect(overlays).toHaveLength(1);
    const result = toolResultOf(events, 'commit');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.result)).toContain('Commit declined by user');

    const log = await git(repoDir, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe('chore: initial commit');
  });

  it('refuses to commit when no UI is bound', async ({ onTestFinished }) => {
    const { session, faux, repoDir, events, overlays } = await createHarness(onTestFinished, {
      confirmAnswer: null,
    });

    await writeFile(join(repoDir, 'feature.txt'), 'hello\n', 'utf8');
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', { files: ['feature.txt'], subject: 'feat: add feature file' }),
      ]),
      fauxAssistantMessage('Cannot commit.'),
    ]);

    await session.prompt('Commit the new file.');

    // No UI means the tool must refuse before ever reaching the overlay.
    expect(overlays).toHaveLength(0);
    const result = toolResultOf(events, 'commit');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.result)).toContain('non-interactive mode');

    const log = await git(repoDir, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe('chore: initial commit');
  });

  it('blocks git commit run through the bash tool', async ({ onTestFinished }) => {
    const { session, faux, repoDir, events } = await createHarness(onTestFinished);

    await writeFile(join(repoDir, 'feature.txt'), 'hello\n', 'utf8');
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'git add -A && git commit -m "feat: sneak past tau"' }),
      ]),
      fauxAssistantMessage('Blocked.'),
    ]);

    await session.prompt('Commit the new file with bash.');

    const result = toolResultOf(events, 'bash');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.result)).toContain('Use the `commit` tool instead');

    const log = await git(repoDir, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe('chore: initial commit');
  });
});
