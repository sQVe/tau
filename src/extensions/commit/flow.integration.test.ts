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
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const tauExtensionsPath = resolve(import.meta.dirname, '..');

interface Harness {
  session: AgentSession;
  faux: FauxProviderRegistration;
  repoDir: string;
  events: AgentSessionEvent[];
  confirmCalls: { title: string; message: string }[];
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

const git = async (repoDir: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, { cwd: repoDir });
  return stdout;
};

const createTempDir = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const createTempRepo = async (): Promise<string> => {
  const repoDir = await createTempDir('tau-flow-repo-');

  await git(repoDir, ['init', '--initial-branch=main']);
  await git(repoDir, ['config', 'user.email', 'tau@example.com']);
  await git(repoDir, ['config', 'user.name', 'Tau Test']);
  await git(repoDir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(repoDir, 'README.md'), '# fixture\n', 'utf8');
  await git(repoDir, ['add', 'README.md']);
  await git(repoDir, ['commit', '-m', 'chore: initial commit']);

  return repoDir;
};

// Any object other than pi's module-private noOpUIContext flips ctx.hasUI to true.
// Only the methods tau actually calls need real behavior.
const createScriptedUI = (
  confirmCalls: { title: string; message: string }[],
  answer: boolean,
): ExtensionUIContext => {
  const target = {
    confirm: (title: string, message: string) => {
      confirmCalls.push({ title, message });
      return Promise.resolve(answer);
    },
  };

  const scriptedUI = new Proxy(target, {
    get: (object, property) =>
      property in object ? Reflect.get(object, property) : () => undefined,
  });

  // The proxy satisfies the ExtensionUIContext surface at runtime by returning no-ops.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return scriptedUI as unknown as ExtensionUIContext;
};

const createHarness = async (
  options: { confirmAnswer?: boolean | null } = {},
): Promise<Harness> => {
  const repoDir = await createTempRepo();
  const agentDir = await createTempDir('tau-flow-agent-');

  const fauxProviderName = 'tau-test';
  const faux = registerFauxProvider({ provider: fauxProviderName });
  cleanups.push(() => {
    faux.unregister();
    return Promise.resolve();
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
  cleanups.push(() => {
    session.dispose();
    return Promise.resolve();
  });

  expect(extensionsResult.errors).toEqual([]);

  const confirmCalls: { title: string; message: string }[] = [];
  const { confirmAnswer = true } = options;
  await session.bindExtensions(
    confirmAnswer === null ? {} : { uiContext: createScriptedUI(confirmCalls, confirmAnswer) },
  );

  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });

  return { session, faux, repoDir, events, confirmCalls };
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
  it('registers the commit tool and command in a real pi session', async () => {
    const { session } = await createHarness();

    expect(session.agent.state.tools.map((tool) => tool.name)).toContain('commit');
  });

  it('commits through the commit tool when the user confirms', async () => {
    const { session, faux, repoDir, events, confirmCalls } = await createHarness();

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

    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]?.title).toBe('feat: add feature file');

    const result = toolResultOf(events, 'commit');
    expect(result.isError).toBe(false);

    const log = await git(repoDir, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe('feat: add feature file');
  });

  it('does not commit when the user declines', async () => {
    const { session, faux, repoDir, events } = await createHarness({ confirmAnswer: false });

    await writeFile(join(repoDir, 'feature.txt'), 'hello\n', 'utf8');
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', { files: ['feature.txt'], subject: 'feat: add feature file' }),
      ]),
      fauxAssistantMessage('Declined.'),
    ]);

    await session.prompt('Commit the new file.');

    expect(toolResultOf(events, 'commit').isError).toBe(true);

    const log = await git(repoDir, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe('chore: initial commit');
  });

  it('refuses to commit when no UI is bound', async () => {
    const { session, faux, repoDir, events } = await createHarness({ confirmAnswer: null });

    await writeFile(join(repoDir, 'feature.txt'), 'hello\n', 'utf8');
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', { files: ['feature.txt'], subject: 'feat: add feature file' }),
      ]),
      fauxAssistantMessage('Cannot commit.'),
    ]);

    await session.prompt('Commit the new file.');

    expect(toolResultOf(events, 'commit').isError).toBe(true);

    const log = await git(repoDir, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe('chore: initial commit');
  });

  it('blocks git commit run through the bash tool', async () => {
    const { session, faux, repoDir, events } = await createHarness();

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
