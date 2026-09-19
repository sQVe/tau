// Replaces the Claude launch and completion branch of pi-interactive-subagents c3e8b53, index.ts and
// plugin/hooks. See LICENSE for its MIT notice.
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import type { ClaudeLoadout, Loadout, Task } from './types.js';

export const channelServerName = 'tau';
export const claudeToolName = (name: string): string => `mcp__${channelServerName}__${name}`;

// Native delegation and questionnaires would bypass admission and the parent. Workers use the channel.
// Claude accepts Task as an alias for Agent, so both names are denied.
export const claudeDeniedTools = ['Agent', 'Task', 'AskUserQuestion'];

// Follow-up and history stay with the root parent.
export const claudeChannelTools = [
  'subagent_report',
  'subagent_question',
  'subagent',
  'subagent_status',
  'subagent_reply',
  'subagent_cancel',
];
// The channel denies every tool outside this list, so it carries what the granted tools need to
// work: Bash offers background execution, which is unusable without reading and stopping the shell.
export const claudeBuiltinTools = [
  'Read',
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'TodoWrite',
];
export const claudeRequiredTools = [
  'Read',
  'Bash',
  'Edit',
  'Write',
  claudeToolName('subagent_report'),
];
export const claudeHookEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'] as const;
export type ClaudeHookEvent = (typeof claudeHookEvents)[number];

export const channelScriptPath = (): string =>
  fileURLToPath(new URL('./claudeChannel.ts', import.meta.url));

// Match Claude's transcript directory naming, including its character replacement rules.
export const claudeProjectSlug = (cwd: string): string => cwd.replaceAll(/[^a-zA-Z0-9-]/g, '-');

export const claudeTranscriptPath = (
  agentDirectory: string,
  cwd: string,
  sessionId: string,
): string => join(agentDirectory, 'projects', claudeProjectSlug(cwd), `${sessionId}.jsonl`);

// CLAUDE_CONFIG_DIR also relocates Claude's own state file, so pin it only when it is already custom.
// A worker that still resolves a different directory refuses at startup, where its transcript path is checked.
export const claudeEnvironment = (loadout: Pick<ClaudeLoadout, 'agentDirectory'>): string[] =>
  loadout.agentDirectory === join(homedir(), '.claude')
    ? []
    : [`CLAUDE_CONFIG_DIR=${loadout.agentDirectory}`];

export const claudeChannelSocket = (directory: string): string => {
  const socket = join(directory, 'channel.sock');

  // Unix socket paths are bounded by the platform, not by the filesystem.
  if (Buffer.byteLength(socket, 'utf8') > 100) {
    throw new Error(
      `Worker record path ${directory} is too long for a Claude control channel socket.`,
    );
  }

  return socket;
};

export const claudeEffort = (thinking: Loadout['thinking']): string => {
  if (thinking === 'off' || thinking === 'minimal') {
    throw new Error(
      `Claude workers need an effort level: use low, medium, high, xhigh, or max instead of ${thinking}.`,
    );
  }

  return thinking;
};

export const claudeArguments = (
  task: Task,
  loadout: ClaudeLoadout,
  directory: string,
): string[] => [
  // `command` defeats a shell function or alias so the canonical executable runs with exactly these arguments.
  'command',
  loadout.executable,
  ...(task.predecessorTaskId
    ? ['--resume', task.nativeSessionId]
    : ['--session-id', task.nativeSessionId]),
  '--model',
  loadout.model,
  '--effort',
  claudeEffort(loadout.thinking),
  '--settings',
  join(directory, 'claudeSettings.json'),
  '--mcp-config',
  join(directory, 'claudeMcp.json'),
  // Pin the channel and the settings sources so other MCP servers and later defaults cannot replace them.
  '--strict-mcp-config',
  '--setting-sources',
  'user,project,local',
  '--disallowedTools',
  ...claudeDeniedTools,
  '--no-chrome',
];

// Claude runs a hook command through a shell, so quote every argument the shell must not expand.
const shellArgument = (argument: string): string => `'${argument.replaceAll("'", `'\\''`)}'`;

const hookCommand = (loadout: ClaudeLoadout, socket: string, event: ClaudeHookEvent): string =>
  [loadout.channelExecutable, loadout.channelScript, 'hook', event, socket]
    .map((argument) => shellArgument(argument))
    .join(' ');

// Settings merge with the user's own sources, so this adds lifecycle hooks without removing CC Safety Net.
export const claudeSettingsDocument = (loadout: ClaudeLoadout, socket: string) => ({
  hooks: Object.fromEntries(
    claudeHookEvents.map((event) => [
      event,
      [{ hooks: [{ type: 'command', command: hookCommand(loadout, socket, event), timeout: 15 }] }],
    ]),
  ),
});

export const claudeMcpDocument = (loadout: ClaudeLoadout, socket: string) => ({
  mcpServers: {
    [channelServerName]: {
      type: 'stdio',
      command: loadout.channelExecutable,
      args: [loadout.channelScript, 'mcp', socket],
    },
  },
});

const claudeEntrySchema = Type.Object({ sessionId: Type.String({ minLength: 1 }) });

const readHead = (path: string, bytes: number) => {
  // Nonblocking open prevents a substituted FIFO from hanging prevalidation. Do not follow replacement symlinks.
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );

  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (!metadata.isFile()) {
      throw new Error('Native session must be an existing regular file.');
    }

    const buffer = Buffer.alloc(bytes);
    let length = 0;

    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!count) {
        break;
      }

      length += count;
    }

    return {
      text: buffer.subarray(0, length).toString('utf8'),
      identity: {
        device: String(metadata.dev),
        inode: String(metadata.ino),
        size: String(metadata.size),
        modified: String(metadata.mtimeNs),
      },
    };
  } finally {
    closeSync(descriptor);
  }
};

export const readClaudeNative = (path: string) => {
  const { text, identity } = readHead(path, 64_001);

  for (const line of text.split('\n').slice(0, 64)) {
    if (!line.trim()) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A partial trailing line is expected while Claude appends to its transcript.
      continue;
    }

    if (Value.Check(claudeEntrySchema, entry)) {
      return { sessionId: entry.sessionId, identity };
    }
  }

  throw new Error('Claude transcript has no session identity in its first entries.');
};

const usageSchema = Type.Object({
  message: Type.Object({
    usage: Type.Object({
      input_tokens: Type.Optional(Type.Number()),
      output_tokens: Type.Optional(Type.Number()),
      cache_read_input_tokens: Type.Optional(Type.Number()),
      cache_creation_input_tokens: Type.Optional(Type.Number()),
    }),
  }),
});

// Native token counts only. Catalog prices and subscription allowance are not available here.
export const claudeUsage = (path: string, limit = 4_000_000) => {
  const { text } = readHead(path, limit);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };

  // The final fragment can be a partially written entry while Claude is still appending.
  for (const line of text.split('\n').slice(0, -1)) {
    if (!line.includes('"usage"')) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!Value.Check(usageSchema, entry)) {
      continue;
    }

    const counts = entry.message.usage;
    usage.input += counts.input_tokens ?? 0;
    usage.output += counts.output_tokens ?? 0;
    usage.cacheRead += counts.cache_read_input_tokens ?? 0;
    usage.cacheWrite += counts.cache_creation_input_tokens ?? 0;
    usage.messages += 1;
  }

  return {
    ...usage,
    complete: Buffer.byteLength(text, 'utf8') < limit,
    source: path,
    note: 'Native token counts from the saved transcript. Not subscription allowance or invoiced cost.',
  };
};

const runWithInput = (
  executable: string,
  arguments_: string[],
  input: string,
  budget: number,
): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CC Safety Net probe did not answer within its budget.'));
    }, budget);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, 64_000);
    });
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });

    // A hook that answers and exits before reading its payload is not a probe failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

const denyProbe = {
  session_id: 'tau-safety-probe',
  transcript_path: '/dev/null',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /' },
};

const decisionSchema = Type.Object({
  hookSpecificOutput: Type.Object({ permissionDecision: Type.String() }),
});

// An installed hook entry is not runtime evidence. Ask the integration itself, without running anything destructive.
export const probeSafetyIntegration = async (
  loadout: Pick<ClaudeLoadout, 'safetyExtension' | 'safetyArguments' | 'channelExecutable' | 'cwd'>,
  budget = 10_000,
): Promise<string> => {
  const probe = await runWithInput(
    loadout.channelExecutable,
    [loadout.safetyExtension, ...loadout.safetyArguments],
    JSON.stringify({ ...denyProbe, cwd: loadout.cwd }),
    budget,
  );

  // Claude honors a hook decision only from a clean exit, so a failed probe is no evidence of denial.
  if (probe.code !== 0) {
    throw new Error(
      `CC Safety Net answered the representative check but exited with ${String(probe.code)}. Worker launch refuses rather than trust an unusable hook.`,
    );
  }

  let decision: unknown;
  try {
    decision = JSON.parse(probe.stdout);
  } catch (error) {
    throw new Error(
      `CC Safety Net did not answer the representative check with a hook decision: ${probe.stdout.slice(0, 500)}`,
      { cause: error },
    );
  }

  if (
    !Value.Check(decisionSchema, decision) ||
    decision.hookSpecificOutput.permissionDecision !== 'deny'
  ) {
    throw new Error(
      'CC Safety Net allowed the representative destructive command. Worker launch refuses rather than run without it.',
    );
  }

  return `CC Safety Net denied the representative destructive command at ${loadout.safetyExtension}.`;
};

const installedPluginsSchema = Type.Object({
  plugins: Type.Record(
    Type.String(),
    Type.Array(Type.Object({ installPath: Type.String({ minLength: 1 }) }), { minItems: 1 }),
  ),
});
const pluginHooksSchema = Type.Object({
  hooks: Type.Object({
    PreToolUse: Type.Array(
      Type.Object({
        hooks: Type.Array(Type.Object({ type: Type.String(), command: Type.String() })),
      }),
      { minItems: 1 },
    ),
  }),
});

const readJson = (path: string): unknown => {
  const { text } = readHead(path, 1_000_000);

  return JSON.parse(text);
};

// Read the installed hook command; the plugin's internal file layout can change.
// The whole command must match: a shell prefix or operator would let Claude skip the hook the probe just proved.
const hookCommandPattern =
  /^(?:node\s+)?"?\$\{CLAUDE_PLUGIN_ROOT\}(\/[\w@./-]+\.js)"?((?:\s+[\w@.=/-]+)*)\s*$/;

const hookInvocation = (command: string, installPath: string) => {
  const script = hookCommandPattern.exec(command);
  if (!script?.[1]) {
    throw new Error(`CC Safety Net registers an unreadable hook command: ${command}`);
  }

  const entry = realpathSync(join(installPath, script[1]));

  return {
    entry,
    arguments: (script[2] ?? '').split(/\s+/).filter(Boolean),
  };
};

export const resolveClaudeSafetyPlugin = (agentDirectory: string, enabled: string[]) => {
  const name = enabled.filter((entry) => entry.startsWith('cc-safety-net@'));
  if (name.length !== 1 || !name[0]) {
    throw new Error(
      'Claude workers need exactly one enabled cc-safety-net plugin. Enable it before launching.',
    );
  }

  const installed = readJson(join(agentDirectory, 'plugins', 'installed_plugins.json'));
  if (!Value.Check(installedPluginsSchema, installed)) {
    throw new Error('Claude plugin installation records are unusable for a worker launch.');
  }

  const entries = installed.plugins[name[0]];
  const installPath = entries?.length === 1 ? entries[0]?.installPath : undefined;
  if (!installPath) {
    throw new Error(`CC Safety Net is enabled as ${name[0]} but is not installed exactly once.`);
  }

  const hooksPath = join(installPath, 'hooks', 'hooks.json');
  const registration = readJson(hooksPath);
  if (!Value.Check(pluginHooksSchema, registration)) {
    throw new Error(`CC Safety Net registers no PreToolUse hook at ${hooksPath}.`);
  }

  const command = registration.hooks.PreToolUse.flatMap((entry) => entry.hooks).find((hook) =>
    hook.command.includes('cc-safety-net'),
  );
  if (!command) {
    throw new Error(`CC Safety Net registers no PreToolUse hook at ${hooksPath}.`);
  }

  return {
    root: installPath,
    hooksPath: realpathSync(hooksPath),
    ...hookInvocation(command.command, installPath),
  };
};

export const claudeVersion = async (executable: string, budget = 10_000): Promise<string> => {
  const probe = await runWithInput(executable, ['--version'], '', budget);
  const version = probe.stdout.trim();
  if (probe.code !== 0 || !version) {
    throw new Error(`Claude executable ${executable} did not report a version.`);
  }

  return version;
};
