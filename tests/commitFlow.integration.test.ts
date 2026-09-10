import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai';
import type { FauxProviderHandle } from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';

// Real Pi sessions and Git commands need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

type RegisterCleanup = TestContext['onTestFinished'];

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

interface Harness {
  session: AgentSession;
  faux: FauxProviderHandle;
  repositoryDirectory: string;
  events: AgentSessionEvent[];
  overlays: string[];
  commandNames: string[];
}

// Isolate fixture commits from user and system Git settings, including hooks.
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const git = async (repositoryDirectory: string, commandArguments: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', commandArguments, {
    cwd: repositoryDirectory,
    env: gitEnvironment,
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

const createTemporaryRepository = async (registerCleanup: RegisterCleanup): Promise<string> => {
  const repositoryDirectory = await createTemporaryDirectory(registerCleanup, 'tau-flow-repo-');

  await git(repositoryDirectory, ['init', '--initial-branch=main']);
  await git(repositoryDirectory, ['config', 'user.email', 'tau@example.com']);
  await git(repositoryDirectory, ['config', 'user.name', 'Tau Test']);
  await git(repositoryDirectory, ['config', 'commit.gpgsign', 'false']);

  // Pi's Git calls do not use gitEnvironment, so disable hooks in the repository too.
  await git(repositoryDirectory, [
    'config',
    'core.hooksPath',
    join(repositoryDirectory, '.no-hooks'),
  ]);

  await writeFile(join(repositoryDirectory, 'README.md'), '# fixture\n', 'utf8');
  await git(repositoryDirectory, ['add', 'README.md']);
  await git(repositoryDirectory, ['commit', '-m', 'chore: initial commit']);

  return repositoryDirectory;
};

// A custom UI context makes Pi report hasUI=true.
const createScriptedUI = (overlays: string[], answer: boolean | 'waive'): ExtensionUIContext => {
  const target: Record<string | symbol, unknown> = {
    custom: async (factory: Parameters<ExtensionUIContext['custom']>[0]) => {
      const component = await factory(
        { requestRender: () => {}, terminal: { rows: 60 } } as never,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
        {} as never,
        () => {},
      );

      overlays.push(component.render(80).join('\n'));

      if (answer === 'waive') {
        return 'waive';
      }

      return answer ? 'approve' : 'abort';
    },
  };

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
  options: { confirmAnswer?: boolean | 'waive' | null } = {},
): Promise<Harness> => {
  const repositoryDirectory = await createTemporaryRepository(registerCleanup);
  const agentDirectory = await createTemporaryDirectory(registerCleanup, 'tau-flow-agent-');

  isolateWebAccessConfig(agentDirectory, registerCleanup);

  const faux = fauxProvider({ provider: 'tau-test' });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: repositoryDirectory,
    agentDir: agentDirectory,
    settingsManager,
    additionalExtensionPaths: [
      tauExtensionsPath,
      bundledQuestionExtensionPath,
      bundledWebAccessExtensionPath,
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });

  await loader.reload();

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });

  modelRuntime.registerNativeProvider(faux.provider);

  const { session, extensionsResult } = await createAgentSession({
    cwd: repositoryDirectory,
    agentDir: agentDirectory,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(repositoryDirectory),
    settingsManager,
    tools: ['read', 'bash', 'edit', 'write', 'commit'],
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

  return { session, faux, repositoryDirectory, events, overlays, commandNames };
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
  it('preserves the provider-resolved endpoint during comment review', async ({
    onTestFinished,
  }) => {
    const { session, faux, repositoryDirectory, events } = await createHarness(onTestFinished);
    const endpoint = 'https://enterprise.example.test';
    const authenticationResolver = vi
      .spyOn(faux.provider.auth.apiKey!, 'resolve')
      .mockImplementation((input) =>
        Promise.resolve({
          auth: input.credential?.key
            ? { apiKey: input.credential.key }
            : { apiKey: 'test-token', baseUrl: endpoint },
        }),
      );
    onTestFinished(() => {
      authenticationResolver.mockRestore();
    });

    await writeFile(join(repositoryDirectory, 'feature.txt'), 'hello\n');

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [{ files: ['feature.txt'], subject: 'feat: add feature' }],
        }),
      ]),
      (_context, _options, _state, model) => {
        expect(model.baseUrl).toBe(endpoint);

        return fauxAssistantMessage('{"findings":[]}');
      },
      fauxAssistantMessage('Committed.'),
    ]);

    await session.prompt('Commit the file.');

    expect(toolResultOf(events, 'commit').isError).toBe(false);
    expect(faux.state.callCount).toBe(3);
  });

  it('reviews a routine lockfile update with complete before-and-after context', async ({
    onTestFinished,
  }) => {
    const { session, faux, repositoryDirectory, events } = await createHarness(onTestFinished);
    const before = 'dependency: version-1\n'.repeat(10_000);
    const after = before.replace('version-1', 'version-2');

    await writeFile(join(repositoryDirectory, 'pnpm-lock.yaml'), before);
    await git(repositoryDirectory, ['add', 'pnpm-lock.yaml']);
    await git(repositoryDirectory, ['commit', '-m', 'chore: add dependencies']);
    await writeFile(join(repositoryDirectory, 'pnpm-lock.yaml'), after);

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [{ files: ['pnpm-lock.yaml'], subject: 'chore: update dependency' }],
        }),
      ]),
      (context) => {
        const user = context.messages[0];
        const payload: unknown = JSON.parse(
          user?.role === 'user' && typeof user.content === 'string' ? user.content : '{}',
        );

        expect((payload as { files: unknown }).files).toContainEqual({
          path: 'pnpm-lock.yaml',
          before,
          after,
        });
        return fauxAssistantMessage('{"findings":[]}');
      },
      fauxAssistantMessage('Committed.'),
    ]);

    await session.prompt('Commit the dependency update.');

    expect(toolResultOf(events, 'commit').isError).toBe(false);
    expect(faux.state.callCount).toBe(3);
  });

  it.for([
    { path: 'unrelated.ts', line: 1 },
    { path: 'retry.ts', line: 9999 },
  ])(
    'rejects review findings outside the supplied source: %j',
    async (location, { onTestFinished }) => {
      const { session, faux, repositoryDirectory, overlays } = await createHarness(onTestFinished, {
        confirmAnswer: false,
      });

      await writeFile(join(repositoryDirectory, 'retry.ts'), 'export const retries = 0;\n');

      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall('commit', {
            groups: [{ files: ['retry.ts'], subject: 'feat: add retry policy' }],
          }),
        ]),
        fauxAssistantMessage(
          JSON.stringify({
            findings: [{ ...location, kind: 'inaccurate', message: 'Invalid location.' }],
          }),
        ),
        fauxAssistantMessage(
          '{"findings":[{"path":"outside.ts","line":1,"kind":"policy","message":"Invalid location."}]}',
        ),
        fauxAssistantMessage('Review failed.'),
      ]);

      await session.prompt('Commit the retry policy.');

      expect(overlays).toHaveLength(1);
      expect(overlays[0]).toContain('invalid findings');
      expect((await git(repositoryDirectory, ['log', '-1', '--pretty=%s'])).trim()).toBe(
        'chore: initial commit',
      );
    },
  );

  it('retries an invalid review once without accepting findings outside the source', async ({
    onTestFinished,
  }) => {
    const { session, faux, repositoryDirectory, events } = await createHarness(onTestFinished);

    await writeFile(join(repositoryDirectory, 'retry.ts'), 'export const retries = 0;\n');

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', { groups: [{ files: ['retry.ts'], subject: 'feat: add retries' }] }),
      ]),
      fauxAssistantMessage(
        '{"findings":[{"path":"AGENTS.md","line":1,"kind":"policy","message":"Invalid target"}]}',
      ),
      fauxAssistantMessage('{"findings":[]}'),
      fauxAssistantMessage('Committed.'),
    ]);

    await session.prompt('Commit the file.');

    expect(toolResultOf(events, 'commit').isError).toBe(false);
    expect(faux.state.callCount).toBe(4);
  });

  it('excludes binary assets from comment context', async ({ onTestFinished }) => {
    const { session, faux, repositoryDirectory, events } = await createHarness(onTestFinished);

    await writeFile(join(repositoryDirectory, 'asset.bin'), Buffer.alloc(300_000));

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', { groups: [{ files: ['asset.bin'], subject: 'feat: add asset' }] }),
      ]),
      (context) => {
        const user = context.messages[0];
        const payload = JSON.parse(
          user?.role === 'user' && typeof user.content === 'string' ? user.content : '{}',
        ) as { files: unknown; binaryPaths: unknown };

        expect(payload.files).toEqual([]);
        expect(payload.binaryPaths).toEqual(['asset.bin']);

        return fauxAssistantMessage('{"findings":[]}');
      },
      fauxAssistantMessage('Committed.'),
    ]);

    await session.prompt('Commit the asset.');

    expect(toolResultOf(events, 'commit').isError).toBe(false);
  });

  it('rechecks a disputed finding without changing the staged content', async ({
    onTestFinished,
  }) => {
    const { session, faux, repositoryDirectory, events, overlays } =
      await createHarness(onTestFinished);

    await writeFile(
      join(repositoryDirectory, 'retry.ts'),
      '// Disabled during migration\nexport const retries = 0;\n',
    );
    const commitInput = { groups: [{ files: ['retry.ts'], subject: 'feat: add retry policy' }] };

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('commit', commitInput)]),
      fauxAssistantMessage(
        JSON.stringify({
          findings: [
            { path: 'retry.ts', line: 1, kind: 'policy', message: 'Remove the migration note.' },
          ],
        }),
      ),
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [
            {
              ...commitInput.groups[0],
              commentDispute: 'The note explains the temporary migration constraint.',
            },
          ],
        }),
      ]),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain('temporary migration constraint');

        return fauxAssistantMessage('{"findings":[]}');
      },
      fauxAssistantMessage('Committed after rechecking the finding.'),
    ]);

    await session.prompt('Commit the retry policy.');
    const results = events.filter(
      (event) => event.type === 'tool_execution_end' && event.toolName === 'commit',
    );

    expect(results.map((event) => event.type === 'tool_execution_end' && event.isError)).toEqual([
      true,
      false,
    ]);

    expect(faux.state.callCount).toBe(5);
    expect(overlays[0]).toContain('rechecked after dispute');
    expect(JSON.stringify(results.at(-1))).toContain('temporary migration constraint');
    expect(JSON.stringify(results.at(-1))).toContain('Remove the migration note.');
  });

  it('reviews staged versions with nearby comments and keeps missing-comment suggestions advisory', async ({
    onTestFinished,
  }) => {
    const { session, faux, repositoryDirectory, events, overlays } =
      await createHarness(onTestFinished);
    const before = '// Retry failures once\nexport const retries = 1;\n';
    const after = '// Retry failures once\nexport const retries = 0;\n';

    await writeFile(join(repositoryDirectory, 'retry.ts'), before);
    await writeFile(join(repositoryDirectory, 'AGENTS.md'), 'Document public retry settings.\n');
    await git(repositoryDirectory, ['add', 'retry.ts', 'AGENTS.md']);
    await git(repositoryDirectory, ['commit', '-m', 'feat: add retries']);
    await writeFile(join(repositoryDirectory, 'retry.ts'), after);

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [{ files: ['retry.ts'], subject: 'fix: disable retries' }],
        }),
      ]),
      (context) => {
        const user = context.messages[0];

        expect(user?.role).toBe('user');

        const payload = JSON.parse(
          user?.role === 'user' && typeof user.content === 'string' ? user.content : '{}',
        ) as { files: unknown; policies: unknown };

        expect(payload.files).toContainEqual({ path: 'retry.ts', before, after });
        expect(payload.policies).toContainEqual({
          path: 'AGENTS.md',
          content: 'Document public retry settings.\n',
        });

        expect(context.tools ?? []).toHaveLength(0);

        return fauxAssistantMessage(
          JSON.stringify({
            findings: [
              {
                path: 'retry.ts',
                line: 2,
                kind: 'missing',
                message: 'Consider explaining why retries are disabled.',
              },
            ],
          }),
        );
      },
      fauxAssistantMessage('Committed with an advisory.'),
    ]);

    await session.prompt('Commit the retry policy.');

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toContain('[advisory]');
    expect(overlays[0]).toContain('Approve and commit');
    expect(toolResultOf(events, 'commit').isError).toBe(false);
  });

  it('requires an explicit user waiver when the reviewer returns malformed output', async ({
    onTestFinished,
  }) => {
    const { session, faux, repositoryDirectory, events, overlays } = await createHarness(
      onTestFinished,
      {
        confirmAnswer: 'waive',
      },
    );

    await writeFile(join(repositoryDirectory, 'retry.ts'), 'export const retries = 0;\n');

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [{ files: ['retry.ts'], subject: 'feat: add retry policy' }],
        }),
      ]),
      fauxAssistantMessage('I could not complete the review.'),
      fauxAssistantMessage('Still invalid.'),
      fauxAssistantMessage('The user waived the failed review.'),
    ]);

    await session.prompt('Commit the retry policy.');

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toContain('Comment review failed');
    expect(overlays[0]).toContain('Waive comment review and commit');
    expect(toolResultOf(events, 'commit').isError).toBe(false);
    expect(JSON.stringify(toolResultOf(events, 'commit').result)).toContain('waived');
  });

  it('reuses an unchanged review and requires user waiver after two automatic retries', async ({
    onTestFinished,
  }) => {
    const { session, faux, repositoryDirectory, events, overlays } = await createHarness(
      onTestFinished,
      {
        confirmAnswer: 'waive',
      },
    );

    await writeFile(
      join(repositoryDirectory, 'retry.ts'),
      '// Retries every error\nexport const retries = 0;\n',
    );
    const request = () =>
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [{ files: ['retry.ts'], subject: 'feat: add retry policy' }],
        }),
      ]);

    faux.setResponses([
      request(),
      fauxAssistantMessage(
        JSON.stringify({
          findings: [
            {
              path: 'retry.ts',
              line: 1,
              kind: 'inaccurate',
              message: 'The comment promises retries.',
            },
          ],
        }),
      ),
      request(),
      request(),
      fauxAssistantMessage('The user waived the finding.'),
    ]);

    await session.prompt('Commit the retry policy.');

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toContain('Waive comment review and commit');
    expect(faux.state.callCount).toBe(5);

    const results = events.filter(
      (event) => event.type === 'tool_execution_end' && event.toolName === 'commit',
    );

    expect(results.map((event) => event.type === 'tool_execution_end' && event.isError)).toEqual([
      true,
      true,
      false,
    ]);

    expect(JSON.stringify(results.at(-1))).toContain('waived');
    expect((await git(repositoryDirectory, ['log', '-1', '--pretty=%s'])).trim()).toBe(
      'feat: add retry policy',
    );
  });

  it('returns blocking comment findings before asking for commit approval', async ({
    onTestFinished,
  }) => {
    const { session, faux, repositoryDirectory, events, overlays } =
      await createHarness(onTestFinished);

    await writeFile(
      join(repositoryDirectory, 'retry.ts'),
      '// Retries every error\nexport const retries = 0;\n',
    );

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [{ files: ['retry.ts'], subject: 'feat: add retry policy' }],
        }),
      ]),
      fauxAssistantMessage(
        JSON.stringify({
          findings: [
            {
              path: 'retry.ts',
              line: 1,
              kind: 'inaccurate',
              message: 'The comment promises retries, but the value disables them.',
            },
          ],
        }),
      ),
      fauxAssistantMessage('I need to correct the comment.'),
    ]);

    await session.prompt('Commit the retry policy.');

    expect(overlays).toHaveLength(0);

    const result = toolResultOf(events, 'commit');

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.result)).toContain('The comment promises retries');
    expect((await git(repositoryDirectory, ['log', '-1', '--pretty=%s'])).trim()).toBe(
      'chore: initial commit',
    );
  });

  it('registers the commit tool and command in a real pi session', async ({ onTestFinished }) => {
    const { session, commandNames } = await createHarness(onTestFinished);

    expect(session.agent.state.tools.map((tool) => tool.name)).toContain('commit');
    expect(commandNames).toContain('commit');
  });

  it('commits through the commit tool when the user confirms', async ({ onTestFinished }) => {
    const { session, faux, repositoryDirectory, events, overlays } =
      await createHarness(onTestFinished);

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
      fauxAssistantMessage('```json\n{"findings":[]}\n```'),
      fauxAssistantMessage('Committed.'),
    ]);

    await session.prompt('Commit the new file.');

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toContain('feat: add feature file');
    expect(overlays[0]).toContain('feature.txt +1 -0');

    const result = toolResultOf(events, 'commit');

    expect(result.isError).toBe(false);

    const log = await git(repositoryDirectory, ['log', '-1', '--pretty=%s']);

    expect(log.trim()).toBe('feat: add feature file');
  });

  it('does not commit when the user declines', async ({ onTestFinished }) => {
    const { session, faux, repositoryDirectory, events, overlays } = await createHarness(
      onTestFinished,
      {
        confirmAnswer: false,
      },
    );

    await writeFile(join(repositoryDirectory, 'feature.txt'), 'hello\n', 'utf8');

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [{ files: ['feature.txt'], subject: 'feat: add feature file' }],
        }),
      ]),
      fauxAssistantMessage('{"findings":[]}'),
      fauxAssistantMessage('Declined.'),
    ]);

    await session.prompt('Commit the new file.');

    expect(overlays).toHaveLength(1);

    const result = toolResultOf(events, 'commit');

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.result)).toContain('Commit declined by user');

    const log = await git(repositoryDirectory, ['log', '-1', '--pretty=%s']);

    expect(log.trim()).toBe('chore: initial commit');
  });

  it('refuses to commit when no UI is bound', async ({ onTestFinished }) => {
    const { session, faux, repositoryDirectory, events, overlays } = await createHarness(
      onTestFinished,
      {
        confirmAnswer: null,
      },
    );

    await writeFile(join(repositoryDirectory, 'feature.txt'), 'hello\n', 'utf8');

    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('commit', {
          groups: [{ files: ['feature.txt'], subject: 'feat: add feature file' }],
        }),
      ]),
      fauxAssistantMessage('Cannot commit.'),
    ]);

    await session.prompt('Commit the new file.');

    expect(overlays).toHaveLength(0);

    const result = toolResultOf(events, 'commit');

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.result)).toContain('non-interactive mode');

    const log = await git(repositoryDirectory, ['log', '-1', '--pretty=%s']);

    expect(log.trim()).toBe('chore: initial commit');
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
