import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished as afterTest } from 'vitest';

import {
  claudeArguments,
  claudeChannelSocket,
  claudeEffort,
  claudeEnvironment,
  claudeMcpDocument,
  claudeProjectSlug,
  claudeSettingsDocument,
  claudeTranscriptPath,
  claudeUsage,
  probeSafetyIntegration,
  readClaudeNative,
  resolveClaudeSafetyPlugin,
} from './claude.js';
import { fixtureClaudeLoadout } from './fixtures/loadout.js';
import type { Task } from './types.js';

const setup = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tau-claude-')));
  afterTest(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return directory;
};

const fixtureTask = (directory: string, overrides: Partial<Task> = {}): Task => ({
  version: 1,
  taskId: 'task-one',
  task: 'Edit the fixture.',
  parentSession: join(directory, 'parent.jsonl'),
  parentSessionId: 'parent',
  ownerId: 'owner',
  nativeSessionId: '11111111-2222-3333-4444-555555555555',
  nativeSessionFile: join(directory, 'transcript.jsonl'),
  createdAt: 1,
  deadline: 60_000,
  cancellationBudget: 5000,
  loadout: fixtureClaudeLoadout(directory),
  ...overrides,
});

it('derives the transcript Claude writes for a working directory', () => {
  expect(claudeProjectSlug('/home/user/code/tau/.bare')).toBe('-home-user-code-tau--bare');
  expect(claudeProjectSlug('/tmp/Slug_Test.dir with space')).toBe('-tmp-Slug-Test-dir-with-space');
  expect(claudeTranscriptPath('/config', '/home/user/code', 'session-id')).toBe(
    '/config/projects/-home-user-code/session-id.jsonl',
  );
});

it('launches the canonical executable without a permission flag', () => {
  const directory = setup();
  const task = fixtureTask(directory);
  const loadout = fixtureClaudeLoadout(directory);
  const launch = claudeArguments(task, loadout, directory);

  expect(launch.slice(0, 2)).toEqual(['command', loadout.executable]);
  expect(launch.join(' ')).not.toContain('dangerously');
  expect(launch.join(' ')).not.toContain('--permission-mode');
  expect(launch).toEqual(
    expect.arrayContaining([
      '--session-id',
      task.nativeSessionId,
      '--model',
      loadout.model,
      '--effort',
      'low',
      '--strict-mcp-config',
      '--setting-sources',
      'user,project,local',
      '--disallowedTools',
      'Agent',
      'AskUserQuestion',
    ]),
  );
});

it('resumes the saved conversation for a follow-up instead of opening a new one', () => {
  const directory = setup();
  const task = fixtureTask(directory, { predecessorTaskId: 'earlier-task' });

  const launch = claudeArguments(task, fixtureClaudeLoadout(directory), directory);

  expect(launch).toContain('--resume');
  expect(launch).not.toContain('--session-id');
  expect(launch[launch.indexOf('--resume') + 1]).toBe(task.nativeSessionId);
});

it('refuses an effort level Claude cannot run', () => {
  expect(claudeEffort('high')).toBe('high');
  expect(() => claudeEffort('off')).toThrow('effort level');
  expect(() => claudeEffort('minimal')).toThrow('effort level');
});

it('pins the configuration directory only when it is already custom', () => {
  expect(claudeEnvironment({ agentDirectory: join(homedir(), '.claude') })).toEqual([]);
  expect(claudeEnvironment({ agentDirectory: '/elsewhere/claude' })).toEqual([
    'CLAUDE_CONFIG_DIR=/elsewhere/claude',
  ]);
});

it('registers lifecycle hooks and one control channel for the worker', () => {
  const directory = setup();
  const loadout = fixtureClaudeLoadout(directory);
  const socket = claudeChannelSocket(directory);
  const settings = claudeSettingsDocument(loadout, socket);
  const mcp = claudeMcpDocument(loadout, socket);

  expect(Object.keys(settings.hooks)).toEqual([
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'Stop',
  ]);
  for (const [event, entries] of Object.entries(settings.hooks)) {
    expect(entries[0]?.hooks[0]?.command).toContain(loadout.channelScript);
    expect(entries[0]?.hooks[0]?.command).toContain(socket);
    expect(entries[0]?.hooks[0]?.command).toContain(event);
  }
  expect(mcp.mcpServers.tau).toMatchObject({
    type: 'stdio',
    command: loadout.channelExecutable,
    args: [loadout.channelScript, 'mcp', socket],
  });
});

it('quotes hook command arguments the worker shell must not expand', () => {
  const directory = setup();
  const loadout = {
    ...fixtureClaudeLoadout(directory),
    channelScript: "/path/with space/it's$HOME.ts",
  };

  const settings = claudeSettingsDocument(loadout, join(directory, 'channel.sock'));
  const command = settings.hooks.SessionStart?.[0]?.hooks[0]?.command ?? '';

  expect(command).toContain(`'/path/with space/it'\\''s$HOME.ts'`);
  expect(command).not.toContain('"');
});

it('refuses a record path too long for a control channel socket', () => {
  const directory = setup();

  expect(() => claudeChannelSocket(join(directory, 'a'.repeat(120)))).toThrow('too long');
});

it('reads Claude session identity from its own transcript', () => {
  const directory = setup();
  const transcript = join(directory, 'transcript.jsonl');
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 'session-one' })}\n{"partial":`,
  );

  expect(readClaudeNative(transcript).sessionId).toBe('session-one');

  writeFileSync(transcript, `${JSON.stringify({ type: 'mode', mode: 'normal' })}\n`);
  expect(() => readClaudeNative(transcript)).toThrow('no session identity');
});

const usageEntry = (input: number, output: number) =>
  JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 2 } },
  });

it('sums native token counts without inventing subscription values', () => {
  const directory = setup();
  const transcript = join(directory, 'usage.jsonl');
  writeFileSync(transcript, `${usageEntry(10, 3)}\n${usageEntry(5, 1)}\n{"message":{"usage":`);

  const usage = claudeUsage(transcript);

  expect(usage).toMatchObject({
    input: 15,
    output: 4,
    cacheRead: 4,
    cacheWrite: 0,
    messages: 2,
    complete: true,
  });
  expect(Object.keys(usage)).not.toContain('cost');
  expect(usage.note).toContain('Not subscription allowance or invoiced cost');
});

const safetyScript = (directory: string, name: string, body: string) => {
  const path = join(directory, name);
  writeFileSync(path, body);
  chmodSync(path, 0o700);

  return path;
};

it('requires runtime evidence that CC Safety Net denies a destructive command', async () => {
  const directory = setup();
  const denying = safetyScript(
    directory,
    'deny.js',
    `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked' } }));`,
  );
  const allowing = safetyScript(directory, 'allow.js', `process.stdout.write('{}');`);
  const silent = safetyScript(directory, 'silent.js', ``);
  const loadout = {
    channelExecutable: process.execPath,
    cwd: directory,
    safetyArguments: ['hook', '--coding-cli'],
  };

  await expect(probeSafetyIntegration({ ...loadout, safetyExtension: denying })).resolves.toContain(
    'denied the representative destructive command',
  );
  await expect(probeSafetyIntegration({ ...loadout, safetyExtension: allowing })).rejects.toThrow(
    'allowed the representative destructive command',
  );
  await expect(probeSafetyIntegration({ ...loadout, safetyExtension: silent })).rejects.toThrow(
    'did not answer',
  );
});

const installPlugin = (
  directory: string,
  command = `node "\${CLAUDE_PLUGIN_ROOT}/dist/bin/cc-safety-net.js" hook --coding-cli`,
) => {
  const install = join(directory, 'plugins', 'cache', 'market', 'cc-safety-net', '2.4.1');
  mkdirSync(join(install, 'hooks'), { recursive: true });
  mkdirSync(join(install, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(install, 'dist', 'bin', 'cc-safety-net.js'), '');
  writeFileSync(
    join(install, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } }),
  );
  writeFileSync(
    join(directory, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'cc-safety-net@market': [{ scope: 'user', installPath: install }] },
    }),
  );

  return install;
};

it('binds the safety hook Claude will actually run', () => {
  const directory = setup();
  const install = installPlugin(directory);

  const plugin = resolveClaudeSafetyPlugin(directory, ['cc-safety-net@market', 'other@market']);

  expect(plugin.entry).toBe(join(install, 'dist', 'bin', 'cc-safety-net.js'));
  expect(plugin.arguments).toEqual(['hook', '--coding-cli']);
  expect(plugin.hooksPath).toBe(join(install, 'hooks', 'hooks.json'));
});

it('refuses a Claude worker without one enabled and installed safety plugin', () => {
  const directory = setup();
  installPlugin(directory);

  expect(() => resolveClaudeSafetyPlugin(directory, [])).toThrow('exactly one enabled');
  expect(() =>
    resolveClaudeSafetyPlugin(directory, ['cc-safety-net@market', 'cc-safety-net@other']),
  ).toThrow('exactly one enabled');
  expect(() => resolveClaudeSafetyPlugin(directory, ['cc-safety-net@missing'])).toThrow(
    'not installed exactly once',
  );
});

it.each([
  `exit 0; node "\${CLAUDE_PLUGIN_ROOT}/dist/bin/cc-safety-net.js" hook --coding-cli`,
  `node "\${CLAUDE_PLUGIN_ROOT}/dist/bin/cc-safety-net.js" hook || true`,
  `node "\${CLAUDE_PLUGIN_ROOT}/dist/bin/cc-safety-net.js" hook; rm -rf /`,
])('refuses a hook command that shell syntax can neutralize: %s', (command) => {
  const directory = setup();
  installPlugin(directory, command);

  expect(() => resolveClaudeSafetyPlugin(directory, ['cc-safety-net@market'])).toThrow(
    'unreadable hook command',
  );
});

it('refuses a safety plugin that registers no usable PreToolUse hook', () => {
  const directory = setup();
  const install = installPlugin(directory, 'echo unrelated');
  writeFileSync(
    join(install, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } }),
  );

  expect(() => resolveClaudeSafetyPlugin(directory, ['cc-safety-net@market'])).toThrow(
    'no PreToolUse hook',
  );
});
