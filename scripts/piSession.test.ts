import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.ts';
import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.ts';

type OnTestFinished = (cleanup: () => void) => void;

interface FakeScript {
  onPrompt?: unknown[];
  onDialogResponse?: unknown[];
  exitCode?: number;
}

interface Got {
  cwd: string;
  arguments: string[];
  settings?: string;
  records: unknown[];
}

const scripts = dirname(fileURLToPath(import.meta.url));
const command = join(scripts, 'piSession.ts');
const fakePi = join(scripts, 'fixtures', 'fakePi.ts');
const accepted = { type: 'response', command: 'prompt', success: true };
const settled = { type: 'agent_settled' };

const launch = {
  type: 'tool_execution_end',
  toolName: 'subagent',
  isError: false,
  result: {
    details: { address: 't64p', labels: { 'tau.assignment': '/a/assignments/w1/assignment.json' } },
  },
};

const createCheckout = (onTestFinished: OnTestFinished, name: string) => {
  const directory = realpathSync(temporaryDirectory(onTestFinished, 'tau-pi-session-checkout-'));

  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name }));

  return directory;
};

const lines = (records: unknown[] = []) => records.map((record) => JSON.stringify(record));

const createSession = async (onTestFinished: OnTestFinished, script: FakeScript = {}) => {
  const cwd = realpathSync(await createTemporaryRepository(onTestFinished));
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-pi-session-agent-');
  const tau = createCheckout(onTestFinished, 'tau');
  const installed = createCheckout(onTestFinished, 'tau');

  writeFileSync(
    join(cwd, 'fake-pi.json'),
    JSON.stringify({
      onPrompt: lines(script.onPrompt),
      onDialogResponse: lines(script.onDialogResponse),
      ...(script.exitCode === undefined ? {} : { exitCode: script.exitCode }),
    }),
  );

  writeFileSync(
    join(agentDirectory, 'settings.json'),
    JSON.stringify({ packages: [installed, 'git:github.com/example/other'] }),
  );

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  return { cwd, tau, installed, agentDirectory };
};

const run = (commandArguments: string[]) => {
  const { promise, resolve } = Promise.withResolvers<{
    code: number | string | null | undefined;
    stdout: string;
    stderr: string;
  }>();

  execFile('node', [command, ...commandArguments], (error, stdout, stderr) => {
    resolve({ code: error === null ? 0 : error.code, stdout, stderr });
  });

  return promise;
};

const readGot = (cwd: string): Got => {
  return JSON.parse(readFileSync(join(cwd, 'fake-pi-got.json'), 'utf8')) as Got;
};

const eventLogPath = (stdout: string) => /^Event log: (.+)$/m.exec(stdout)?.[1] ?? '';
const settingsPath = (cwd: string) => join(cwd, '.pi', 'settings.json');

it('gives Pi the working directory, the prompt, and the checkout', async ({ onTestFinished }) => {
  const { cwd, tau, installed } = await createSession(onTestFinished, {
    onPrompt: [accepted, settled],
  });

  const result = await run(['--pi', fakePi, '--tau', tau, '--cwd', cwd, '--prompt', 'say hello']);
  const got = readGot(cwd);

  expect(result).toMatchObject({ code: 0, stderr: '' });
  expect(got.cwd).toBe(cwd);
  expect(got.records).toEqual([expect.objectContaining({ type: 'prompt', message: 'say hello' })]);

  expect(JSON.parse(got.settings ?? '')).toEqual({
    packages: [tau, { source: installed, extensions: [], skills: [], prompts: [], themes: [] }],
  });

  expect(got.arguments.slice(0, 4)).toEqual(['--mode', 'rpc', '--approve', '--session-dir']);
  expect(existsSync(join(cwd, '.pi'))).toBe(false);
  expect(readFileSync(eventLogPath(result.stdout), 'utf8')).toContain('agent_settled');
});

it('reads the prompt from a file and passes the model', async ({ onTestFinished }) => {
  const { cwd, tau } = await createSession(onTestFinished, { onPrompt: [accepted, settled] });
  const promptFile = join(cwd, 'prompt.txt');

  writeFileSync(promptFile, 'from a file\n');

  const session = ['--pi', fakePi, '--tau', tau, '--cwd', cwd];
  const result = await run([...session, '--prompt-file', promptFile, '--model', 'openai/x']);

  const got = readGot(cwd);

  expect(result.code).toBe(0);
  expect(got.records).toEqual([expect.objectContaining({ message: 'from a file\n' })]);
  expect(got.arguments.slice(-2)).toEqual(['--model', 'openai/x']);
});

it('waits for the worker report and cancels a dialog', async ({ onTestFinished }) => {
  const report = {
    type: 'message_start',
    message: { role: 'custom', customType: 'tau-worker-report', details: { assignmentId: 'w1' } },
  };

  const { cwd, tau } = await createSession(onTestFinished, {
    onPrompt: [
      accepted,
      launch,
      settled,
      { type: 'extension_ui_request', id: 'd1', method: 'confirm' },
    ],
    onDialogResponse: [report, settled],
  });

  const result = await run(['--pi', fakePi, '--tau', tau, '--cwd', cwd, '--prompt', 'launch']);

  expect(result).toMatchObject({ code: 0, stderr: '' });

  expect(readGot(cwd).records[1]).toEqual({
    type: 'extension_ui_response',
    id: 'd1',
    cancelled: true,
  });

  expect(readFileSync(eventLogPath(result.stdout), 'utf8')).toContain('tau-worker-report');
});

it('fails and names the event log when Pi exits with a non-zero code', async ({
  onTestFinished,
}) => {
  const { cwd, tau } = await createSession(onTestFinished, { onPrompt: [accepted], exitCode: 3 });
  const result = await run(['--pi', fakePi, '--tau', tau, '--cwd', cwd, '--prompt', 'fail']);
  const eventLog = eventLogPath(result.stdout);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Pi exited with code 3');
  expect(readFileSync(eventLog, 'utf8')).toContain('"command":"prompt"');
  expect(existsSync(join(cwd, '.pi'))).toBe(false);
});

it('fails when Pi refuses the prompt', async ({ onTestFinished }) => {
  const { cwd, tau } = await createSession(onTestFinished, {
    onPrompt: [{ type: 'response', command: 'prompt', success: false, error: 'no model' }],
  });

  const result = await run(['--pi', fakePi, '--tau', tau, '--cwd', cwd, '--prompt', 'refuse']);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Pi refused the prompt: no model');
  expect(existsSync(eventLogPath(result.stdout))).toBe(true);
  expect(existsSync(join(cwd, '.pi'))).toBe(false);
});

it('fails after the timeout and names the worker that still runs', async ({ onTestFinished }) => {
  const { cwd, tau } = await createSession(onTestFinished, {
    onPrompt: [accepted, 'not JSON', launch, settled],
  });

  const session = ['--pi', fakePi, '--tau', tau, '--cwd', cwd];
  const result = await run([...session, '--prompt', 'wait', '--timeout', '1']);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('did not end within 1 seconds');
  expect(result.stderr).toContain('hc address t64p');
  expect(readFileSync(eventLogPath(result.stdout), 'utf8')).toContain('not JSON');
  expect(existsSync(join(cwd, '.pi'))).toBe(false);
});

it.for([
  { name: 'a missing --cwd', withCwd: false, extra: ['--prompt', 'hello'], cause: '--cwd' },
  { name: 'a missing prompt', withCwd: true, extra: [], cause: 'prompt is required' },
  {
    name: 'both prompt options',
    withCwd: true,
    extra: ['--prompt', 'hello', '--prompt-file', 'prompt.txt'],
    cause: 'not both',
  },
  {
    name: 'a timeout that is no positive integer',
    withCwd: true,
    extra: ['--prompt', 'hello', '--timeout', '0'],
    cause: '--timeout',
  },
])('refuses $name and starts no Pi', async ({ withCwd, extra, cause }, { onTestFinished }) => {
  const { cwd, tau } = await createSession(onTestFinished, { onPrompt: [accepted, settled] });
  const cwdArguments = withCwd ? ['--cwd', cwd] : [];
  const result = await run(['--pi', fakePi, '--tau', tau, ...cwdArguments, ...extra]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(cause);
  expect(existsSync(join(cwd, 'fake-pi-got.json'))).toBe(false);
  expect(existsSync(join(cwd, '.pi'))).toBe(false);
});

it('refuses existing project settings and leaves them unchanged', async ({ onTestFinished }) => {
  const { cwd, tau } = await createSession(onTestFinished, { onPrompt: [accepted, settled] });

  mkdirSync(join(cwd, '.pi'));
  writeFileSync(settingsPath(cwd), '{"theme":"dark"}\n');

  const result = await run(['--pi', fakePi, '--tau', tau, '--cwd', cwd, '--prompt', 'hello']);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(settingsPath(cwd));
  expect(result.stderr).toContain('already exists');
  expect(existsSync(join(cwd, 'fake-pi-got.json'))).toBe(false);
  expect(readFileSync(settingsPath(cwd), 'utf8')).toBe('{"theme":"dark"}\n');
});

it('writes no settings when the user settings install the checkout', async ({ onTestFinished }) => {
  const { cwd, installed } = await createSession(onTestFinished, {
    onPrompt: [accepted, settled],
  });

  mkdirSync(join(cwd, '.pi'));
  writeFileSync(settingsPath(cwd), '{"theme":"dark"}\n');

  const result = await run(['--pi', fakePi, '--tau', installed, '--cwd', cwd, '--prompt', 'hi']);

  expect(result).toMatchObject({ code: 0, stderr: '' });
  expect(readGot(cwd).settings).toBe('{"theme":"dark"}\n');
  expect(readFileSync(settingsPath(cwd), 'utf8')).toBe('{"theme":"dark"}\n');
});

it('keeps a .pi directory that held other files', async ({ onTestFinished }) => {
  const { cwd, tau } = await createSession(onTestFinished, { onPrompt: [accepted, settled] });

  mkdirSync(join(cwd, '.pi'));
  writeFileSync(join(cwd, '.pi', 'qa.md'), '# QA\n');

  const result = await run(['--pi', fakePi, '--tau', tau, '--cwd', cwd, '--prompt', 'hello']);

  expect(result.code).toBe(0);
  expect(existsSync(settingsPath(cwd))).toBe(false);
  expect(readFileSync(join(cwd, '.pi', 'qa.md'), 'utf8')).toBe('# QA\n');
});

it('prints the usage for --help', async () => {
  const result = await run(['--help']);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('--prompt-file');
});
