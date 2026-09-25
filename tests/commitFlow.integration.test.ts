import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { fauxAssistantMessage, fauxToolCall, fauxProvider } from '@earendil-works/pi-ai';
import type { FauxProviderHandle } from '@earendil-works/pi-ai';
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from './gitRepository.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createBoundSession } from './piSession.js';

type RegisterCleanup = TestContext['onTestFinished'];

interface Harness {
  session: AgentSession;
  faux: FauxProviderHandle;
  repositoryDirectory: string;
  events: AgentSessionEvent[];
  overlays: string[];
}

// Real Pi sessions and Git commands need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);

const tauExtensionsPath = resolve(import.meta.dirname, '../src/extensions');

const bundledQuestionExtensionPath = resolve(
  import.meta.dirname,
  '../node_modules/@juicesharp/rpiv-ask-user-question/index.ts',
);

const bundledWebAccessExtensionPath = resolve(
  import.meta.dirname,
  '../node_modules/pi-web-access/index.ts',
);

const git = async (repositoryDirectory: string, commandArguments: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', commandArguments, {
    cwd: repositoryDirectory,
  });

  return stdout;
};

const createTemporaryDirectory = async (
  registerCleanup: RegisterCleanup,
  prefix: string,
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  registerCleanup(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

const createCommittedRepository = async (registerCleanup: RegisterCleanup): Promise<string> => {
  const repositoryDirectory = await createTemporaryRepository(registerCleanup, 'tau-flow-repo-');

  await writeFile(join(repositoryDirectory, 'README.md'), '# fixture\n', 'utf8');
  await git(repositoryDirectory, ['add', 'README.md']);
  await git(repositoryDirectory, ['commit', '-m', 'chore: initial commit']);

  return repositoryDirectory;
};

// A custom UI context makes Pi report hasUI=true.
const createScriptedUI = (overlays: string[]): ExtensionUIContext =>
  new Proxy({} as ExtensionUIContext, {
    get: (_object, property) => {
      overlays.push(String(property));
      throw new Error(`Unexpected commit UI: ${String(property)}`);
    },
  });

const createHarness = async (
  registerCleanup: RegisterCleanup,
  options: { hasUI?: boolean } = {},
): Promise<Harness> => {
  const repositoryDirectory = await createCommittedRepository(registerCleanup);
  const agentDirectory = await createTemporaryDirectory(registerCleanup, 'tau-flow-agent-');

  isolateWebAccessConfig(agentDirectory, registerCleanup);

  const faux = fauxProvider({ provider: 'tau-test' });
  const overlays: string[] = [];
  const { hasUI = true } = options;

  const { session } = await createBoundSession(
    registerCleanup,
    {
      cwd: repositoryDirectory,
      agentDirectory,
      providers: [faux],
      tools: ['read', 'bash', 'edit', 'write', 'commit'],
      extensionPaths: [
        tauExtensionsPath,
        bundledQuestionExtensionPath,
        bundledWebAccessExtensionPath,
      ],
    },
    hasUI ? { uiContext: createScriptedUI(overlays) } : {},
  );

  const events: AgentSessionEvent[] = [];

  session.subscribe((event) => {
    events.push(event);
  });

  return { session, faux, repositoryDirectory, events, overlays };
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
  it('returns a message hook failure as a tool error without UI', async ({ onTestFinished }) => {
    const { session, faux, repositoryDirectory, events, overlays } =
      await createHarness(onTestFinished);

    await git(repositoryDirectory, ['config', 'core.hooksPath', '.git/hooks']);

    await writeFile(
      join(repositoryDirectory, '.git/hooks/commit-msg'),
      '#!/bin/sh\necho invalid message >&2\nexit 1\n',
    );

    await chmod(join(repositoryDirectory, '.git/hooks/commit-msg'), 0o755);
    await writeFile(join(repositoryDirectory, 'message.txt'), 'value\n');

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [{ files: ['message.txt'], subject: 'feat: add message' }],
        }),
      ]),
      fauxAssistantMessage('The message hook failed.'),
    ]);

    await session.prompt('Commit the message file.');

    const result = toolResultOf(events, 'commit');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.result)).toContain('git commit failed');
    expect(JSON.stringify(result.result)).toContain('invalid message');
    expect(overlays).toHaveLength(0);
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

    expect((await git(repositoryDirectory, ['log', '-1', '--pretty=%s'])).trim()).toBe(
      'chore: initial commit',
    );
  });

  it.for([true, false])('commits with hasUI=%s', async (hasUI, { onTestFinished }) => {
    const { session, faux, repositoryDirectory, events, overlays } = await createHarness(
      onTestFinished,
      { hasUI },
    );

    await writeFile(join(repositoryDirectory, 'feature.txt'), 'hello\n', 'utf8');

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [
            {
              files: ['feature.txt'],
              subject: 'feat: add feature file',
              body: 'Prove the commit tool runs end to end.',
            },
          ],
        }),
      ]),
      fauxAssistantMessage('Committed.'),
    ]);

    await session.prompt('Commit the new file.');

    expect(overlays).toHaveLength(0);

    const result = toolResultOf(events, 'commit');

    expect(result.isError).toBe(false);

    const log = await git(repositoryDirectory, ['log', '-1', '--pretty=%s']);

    expect(log.trim()).toBe('feat: add feature file');
  });

  it('blocks git commit run through the bash tool', async ({ onTestFinished }) => {
    const { session, faux, repositoryDirectory, events } = await createHarness(onTestFinished);

    await writeFile(join(repositoryDirectory, 'feature.txt'), 'hello\n', 'utf8');

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

    const log = await git(repositoryDirectory, ['log', '-1', '--pretty=%s']);

    expect(log.trim()).toBe('chore: initial commit');
  });
});
