import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { expect, it, onTestFinished, vi } from 'vitest';

import { installCommandShim } from '../../tests/commandShimFake.js';
import { declinedExec } from '../../tests/declinedExecFake.js';
import { createHcFake } from '../../tests/hcFake.js';
import type { HcFake } from '../../tests/hcFake.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { connect, runWithEnvironment } from './connect.js';
import { HcError } from './hc.js';
import type { HcRuntime } from './hc.js';

interface FakeChild {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  on: (event: string, listener: (...argumentsList: unknown[]) => void) => FakeChild;
  emit: (event: string, ...argumentsList: unknown[]) => boolean;
}

vi.mock(import('node:child_process'), async (importOriginal) => {
  const actual = await importOriginal();
  const spawnMock = vi.fn<typeof actual.spawn>(actual.spawn);

  return { ...actual, spawn: spawnMock as unknown as typeof actual.spawn };
});

const spawnMock = vi.mocked(spawn);

const terminal = {
  address: 't7',
  state: 'live',
  labels: { role: 'worker' },
};

const hello = {
  generation: 1,
  version: '0.1.16',
  core: { id: 'core-id', name: 'local' },
  framed: false,
  methods: ['hello'],
  features: [],
};

const runtimeOf = (fake: HcFake): HcRuntime => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const spawnRuntime = (): HcRuntime => ({
  exec: declinedExec,
  connect,
  cwd: '/repository',
});

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const helloLine = JSON.stringify({ jsonrpc: '2.0', id: 1, result: hello });
const terminalLine = JSON.stringify({ jsonrpc: '2.0', id: 2, result: terminal });

const script = (...lines: string[]): string => lines.join('\n');

const readHello = ['read -r _hello', `printf '%s\\n' ${shellQuote(helloLine)}`];

const installStub = async (stubScript: string): Promise<void> => {
  await installCommandShim('hc', {
    otherCalls: 'fail',
    overrides: [{ match: ' connect ', script: stubScript }],
  });
};

const createFakeChild = (): FakeChild => {
  // oxlint-disable-next-line unicorn/prefer-event-target -- A Node child process is an EventEmitter.
  const events = new EventEmitter();

  const child: FakeChild = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(),
    on: (event, listener) => {
      events.on(event, listener);

      return child;
    },
    emit: (event, ...argumentsList) => events.emit(event, ...argumentsList),
  };

  return child;
};

it('writes hello and terminal.run to one connect call and returns the terminal', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, hello);
  fake.replyConnect('terminal.run', 2, terminal);

  const env = { TAU_PROBE: 'hello-env' };

  const result = await runWithEnvironment(runtimeOf(fake), {
    argv: ['sh', '-c', 'echo $X'],
    env,
    cwd: '/working',
    labels: { role: 'probe' },
    noParent: true,
  });

  expect(fake.connectCalls).toHaveLength(1);
  expect(fake.messages.map((message) => message.method)).toEqual(['hello', 'terminal.run']);

  expect(fake.messages[1]?.params).toEqual({
    argv: ['sh', '-c', 'echo $X'],
    env,
    cwd: '/working',
    labels: { role: 'probe' },
    no_parent: true,
  });

  expect(result.address).toBe('t7');
});

it('raises an HcError value from the entry on a JSON-RPC error reply', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, hello);

  fake.failConnect('terminal.run', 2, {
    code: -32000,
    message: 'not_found',
    data: { kind: 'not_found', hint: 'gone' },
  });

  const failure = await runWithEnvironment(runtimeOf(fake), { argv: ['true'], env: {} }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'not_found' });
});

it('rejects a malformed trailing line after both replies', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, hello);
  fake.replyConnect('terminal.run', 2, terminal);
  fake.appendConnectOutput('not-json\n');

  const failure = await runWithEnvironment(runtimeOf(fake), { argv: ['true'], env: {} }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'malformed' });
});

it('turns a synchronous spawn failure into an HcError', async () => {
  spawnMock.mockImplementationOnce(() => {
    throw new Error('spawn E2BIG');
  });

  const failure = await connect([helloLine, terminalLine]).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'spawn_failed' });
});

it('rejects with the stdout failure after the child closes cleanly', async () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const pending = connect([helloLine, terminalLine]);

  child.stdout.emit('error', new Error('read broke'));
  child.emit('close', 0, null);

  const failure = await pending.catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'read_failed' });
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});

it('rejects with the input failure when hc closes stdin before a large request', async () => {
  await installStub(script('exec 0<&-', 'exec sleep 60'));

  const failure = await runWithEnvironment(spawnRuntime(), {
    argv: ['true'],
    env: { FILLER: 'x'.repeat(4 * 1024 * 1024) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'write_failed' });
});

it('replies only after the one-shot call ends stdin', async () => {
  await installStub(
    script(
      'while read -r _line; do :; done',
      `printf '%s\\n' ${shellQuote(helloLine)}`,
      `printf '%s\\n' ${shellQuote(terminalLine)}`,
      'exit 0',
    ),
  );

  const result = await runWithEnvironment(spawnRuntime(), { argv: ['true'], env: {} });

  expect(result.address).toBe('t7');
});

it('reports missing_reply when hc closes stdout before reply 2', async () => {
  await installStub(script(...readHello, 'exit 0'));

  const failure = await runWithEnvironment(spawnRuntime(), { argv: ['true'], env: {} }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'missing_reply' });
});

it('reports the exit code when hc exits non-zero after reply 2', async () => {
  await installStub(
    script(...readHello, 'read -r _run', `printf '%s\\n' ${shellQuote(terminalLine)}`, 'exit 7'),
  );

  const failure = await runWithEnvironment(spawnRuntime(), { argv: ['true'], env: {} }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'exited', exitCode: 7 });
});

it('reports the exit code when hc exits non-zero before reply 2', async () => {
  await installStub(script(...readHello, 'exit 7'));

  const failure = await runWithEnvironment(spawnRuntime(), { argv: ['true'], env: {} }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'exited', exitCode: 7 });
});

it('rejects malformed output once the child closes', async () => {
  await installStub(
    script(...readHello, 'read -r _run', `printf '%s\\n' ${shellQuote('not-json')}`, 'exit 0'),
  );

  const failure = await runWithEnvironment(spawnRuntime(), { argv: ['true'], env: {} }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'malformed' });
});

it('has no running child when an aborted call settles', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-hc-abort-');
  const processIdFile = join(directory, 'pid');

  await installStub(script(`printf '%s' "$$" > ${shellQuote(processIdFile)}`, 'exec sleep 60'));

  const controller = new AbortController();

  const started = new Promise<void>((resolve) => {
    const watcher = watch(directory, () => {
      watcher.close();
      resolve();
    });

    onTestFinished(() => {
      watcher.close();
    });
  });

  const pending = runWithEnvironment(
    { ...spawnRuntime(), signal: controller.signal },
    { argv: ['true'], env: {} },
  );

  await started;
  controller.abort();

  const failure = await pending.catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'exited' });

  const processId = Number(readFileSync(processIdFile, 'utf8'));
  expect(() => process.kill(processId, 0)).toThrow('ESRCH');
});
