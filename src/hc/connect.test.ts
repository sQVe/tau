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
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  on: (event: string, listener: (...argumentsList: unknown[]) => void) => FakeChild;
  off: (event: string, listener: (...argumentsList: unknown[]) => void) => FakeChild;
  once: (event: string, listener: (...argumentsList: unknown[]) => void) => FakeChild;
  listenerCount: (event: string) => number;
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
  cwd: process.cwd(),
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
    exitCode: null,
    signalCode: null,
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(),
    on: (event, listener) => {
      events.on(event, listener);

      return child;
    },
    off: (event, listener) => {
      events.off(event, listener);

      return child;
    },
    once: (event, listener) => {
      events.once(event, listener);

      return child;
    },
    listenerCount: (event) => events.listenerCount(event),
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

  expect(fake.messages[1]?.params).toStrictEqual({
    argv: ['sh', '-c', 'echo $X'],
    env,
    cwd: '/working',
    labels: { role: 'probe' },
    no_parent: true,
  });

  expect(result.address).toBe('t7');
});

it('sends the terminal name and parent in terminal.run', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, hello);
  fake.replyConnect('terminal.run', 2, terminal);

  await runWithEnvironment(runtimeOf(fake), {
    argv: ['true'],
    env: {},
    name: 'scout-3f9a2c1d',
    parent: 't1',
  });

  expect(fake.messages[1]?.params).toMatchObject({ name: 'scout-3f9a2c1d', parent: 't1' });
});

it('starts a worker with no_notify when asked', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, hello);
  fake.replyConnect('terminal.run', 2, terminal);

  await runWithEnvironment(runtimeOf(fake), { argv: ['true'], env: {}, noNotify: true });

  expect(fake.messages[1]?.params).toMatchObject({ no_notify: true });
});

it('defaults the terminal working directory to the runtime directory', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, hello);
  fake.replyConnect('terminal.run', 2, terminal);

  await runWithEnvironment(runtimeOf(fake), { argv: ['true'], env: {} });

  expect(fake.messages[1]?.params).toMatchObject({ cwd: '/repository' });
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

it('rejects an id-less reply after both replies', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, hello);
  fake.replyConnect('terminal.run', 2, terminal);
  fake.appendConnectOutput(`${JSON.stringify({ jsonrpc: '2.0', result: terminal })}\n`);

  const failure = await runWithEnvironment(runtimeOf(fake), { argv: ['true'], env: {} }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'malformed' });
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

it('reports spawn_failed for a child error before spawn', async () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const pending = connect([helloLine, terminalLine]);

  child.emit('error', new Error('spawn hc ENOENT'));
  child.emit('close', -2, null);

  const failure = await pending.catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ kind: 'spawn_failed' });
  expect((failure as HcError).message).toContain('hc connect failed to start');
});

it('reports connect_failed for a child error after spawn', async () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const pending = connect([helloLine, terminalLine]);

  child.emit('spawn');
  child.emit('error', new Error('kill EPERM'));
  child.emit('close', null, null);

  const failure = await pending.catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ kind: 'connect_failed' });
  expect((failure as HcError).message).toBe('hc connect failed: kill EPERM');
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

it('keeps a stream failure recorded before an abort when the child closes', async () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const controller = new AbortController();

  const pending = connect([helloLine], { signal: controller.signal }).catch(
    (error: unknown) => error,
  );

  child.stdout.emit('error', new Error('read broke'));
  controller.abort();
  child.emit('close', null, 'SIGTERM');

  const failure = await pending;

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'read_failed' });
});

it('escalates a stream failure to SIGKILL when the child ignores SIGTERM', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const pending = connect([helloLine, terminalLine]).catch((error: unknown) => error);

  child.stdout.emit('error', new Error('read broke'));
  vi.advanceTimersByTime(5000);

  expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
  expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');

  child.emit('close', null, 'SIGKILL');

  expect(await pending).toMatchObject({ name: 'HcError', kind: 'read_failed' });
});

it('does not send SIGKILL when the child closes after SIGTERM', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const pending = connect([helloLine, terminalLine]).catch((error: unknown) => error);

  child.stdout.emit('error', new Error('read broke'));
  child.emit('close', null, 'SIGTERM');
  vi.advanceTimersByTime(5000);

  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(await pending).toMatchObject({ name: 'HcError', kind: 'read_failed' });
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

it('includes the trimmed stderr of a non-zero exit in the message', async () => {
  await installStub(script(...readHello, "printf '%s\\n' 'no terminal host' >&2", 'exit 7'));

  const failure = await runWithEnvironment(spawnRuntime(), { argv: ['true'], env: {} }).catch(
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
    name: 'HcError',
    kind: 'exited',
    exitCode: 7,
    message: 'hc connect exited with code 7: no terminal host',
  });
});

it('runs hc connect in the runtime directory', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-hc-working-');
  const outputPath = join(directory, 'working-directory');

  await installStub(
    script(
      ...readHello,
      'read -r _run',
      `pwd > ${shellQuote(outputPath)}`,
      `printf '%s\\n' ${shellQuote(terminalLine)}`,
      'exit 0',
    ),
  );

  const result = await runWithEnvironment(
    { ...spawnRuntime(), cwd: directory },
    { argv: ['true'], env: {} },
  );

  expect(result.address).toBe('t7');
  const recordedDirectory = readFileSync(outputPath, 'utf8').trim();
  expect(recordedDirectory).toBe(directory);
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

it('spawns the child with only the environment the caller passes', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-hc-environment-');
  const outputPath = join(directory, 'environment');

  vi.stubEnv('TAU_ABSENT', 'from-process-env');

  await installStub(
    script(
      'while read -r _line; do :; done',
      `printf '%s' "\${TAU_ABSENT-unset}" > ${shellQuote(outputPath)}`,
      'exit 0',
    ),
  );

  await connect([helloLine], { env: { PATH: process.env['PATH'] ?? '' } });

  expect(readFileSync(outputPath, 'utf8')).toBe('unset');
});

it('has no running child when an aborted call settles', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-hc-abort-');
  const processIdFile = join(directory, 'pid');

  const pendingProcessIdFile = join(directory, 'pid.pending');

  await installStub(
    script(
      `printf '%s' "$$" > ${shellQuote(pendingProcessIdFile)}`,
      `mv ${shellQuote(pendingProcessIdFile)} ${shellQuote(processIdFile)}`,
      'exec sleep 60',
    ),
  );

  const controller = new AbortController();

  const started = new Promise<void>((resolve) => {
    const watcher = watch(directory, (_eventType, fileName) => {
      if (fileName !== 'pid') {
        return;
      }

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
  expect(failure).toMatchObject({ name: 'HcError', kind: 'aborted' });

  const processId = Number(readFileSync(processIdFile, 'utf8'));
  expect(() => process.kill(processId, 0)).toThrow('ESRCH');
});

it('rejects an already aborted signal before spawning', async () => {
  spawnMock.mockClear();

  const failure = await connect([helloLine], { signal: AbortSignal.abort() }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ kind: 'aborted' });
  expect(spawnMock).not.toHaveBeenCalled();
});

it('sends SIGTERM and destroys both pipes when an aborted child exits', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const controller = new AbortController();

  const pending = connect([helloLine], { signal: controller.signal }).catch(
    (error: unknown) => error,
  );

  controller.abort();

  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');

  child.emit('exit', null, 'SIGTERM');

  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);

  child.emit('close', null, 'SIGTERM');

  expect(await pending).toMatchObject({ name: 'HcError', kind: 'aborted' });
});

it('does not send SIGKILL when the child has already exited at the kill grace', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const controller = new AbortController();

  const pending = connect([helloLine], { signal: controller.signal }).catch(
    (error: unknown) => error,
  );

  controller.abort();

  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');

  child.exitCode = 0;
  await vi.advanceTimersByTimeAsync(5000);

  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');

  child.emit('close', 0, null);

  expect(await pending).toMatchObject({ name: 'HcError', kind: 'aborted' });
});

it('settles at the confirm deadline without close and appends the did-not-exit clause', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const controller = new AbortController();

  const pending = connect([helloLine], { signal: controller.signal }).catch(
    (error: unknown) => error,
  );

  controller.abort();
  await vi.advanceTimersByTimeAsync(7000);

  const failure = await pending;

  expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
  expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'aborted' });

  expect((failure as HcError).message).toBe(
    'hc connect was aborted and did not exit after SIGKILL',
  );
});

it('destroys both pipes and detaches its exit hook at the confirm deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const controller = new AbortController();

  const pending = connect([helloLine], { signal: controller.signal }).catch(
    (error: unknown) => error,
  );

  controller.abort();

  expect(child.listenerCount('exit')).toBe(1);

  await vi.advanceTimersByTimeAsync(7000);
  await pending;

  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
  expect(child.listenerCount('exit')).toBe(0);
});

it('destroys both pipes when the child exited before cancellation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const controller = new AbortController();

  const pending = connect([helloLine], { signal: controller.signal }).catch(
    (error: unknown) => error,
  );

  child.exitCode = 0;
  child.emit('exit', 0, null);
  controller.abort();

  expect(child.kill).not.toHaveBeenCalled();
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);

  await vi.advanceTimersByTimeAsync(7000);
  await pending;

  expect(child.kill).not.toHaveBeenCalled();
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
});

it('reports output_too_large when stdout passes the cap before a nonzero exit', async () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const pending = connect([helloLine]).catch((error: unknown) => error);

  child.stdout.emit('data', 'a'.repeat(1_048_577));
  child.emit('close', 7, null);

  const failure = await pending;

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'output_too_large' });
});

it('ignores a close that arrives after settlement', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const controller = new AbortController();

  const pending = connect([helloLine], { signal: controller.signal }).catch(
    (error: unknown) => error,
  );

  controller.abort();
  await vi.advanceTimersByTimeAsync(7000);

  const failure = await pending;

  expect(child.listenerCount('close')).toBe(0);

  child.emit('close', 0, null);

  expect(failure).toMatchObject({ kind: 'aborted' });
});

it('keeps the abort kind when stdout overflows after the abort at the fallback deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const controller = new AbortController();

  const pending = connect([helloLine], { signal: controller.signal }).catch(
    (error: unknown) => error,
  );

  controller.abort();
  child.stdout.emit('data', 'a'.repeat(1_048_577));

  await vi.advanceTimersByTimeAsync(7000);

  const failure = await pending;

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'aborted' });
});

it('reports output_too_large when an input failure arrives before the overflow', async () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const pending = connect([helloLine]).catch((error: unknown) => error);

  child.stdin.emit('error', new Error('write broke'));
  child.stdout.emit('data', 'a'.repeat(1_048_577));
  child.emit('close', 7, null);

  const failure = await pending;

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'output_too_large' });
});

it('rejects output_too_large past the stdout cap and stops the child', async () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const pending = connect([helloLine]).catch((error: unknown) => error);

  child.stdout.emit('data', 'a'.repeat(1_048_577));

  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');

  child.stdout.emit('data', 'discarded');
  child.emit('close', 0, null);

  const failure = await pending;

  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'output_too_large' });

  expect((failure as HcError).message).toBe('hc connect printed more than 1048576 characters');
});

it('keeps the first 4096 stderr characters and keeps reading the rest', async () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const pending = connect([helloLine]);

  child.stderr.emit('data', 'x'.repeat(5000));
  child.stderr.emit('data', 'y'.repeat(5000));
  child.emit('close', 0, null);

  const result = await pending;

  expect(result.stderr).toBe('x'.repeat(4096));
  expect(result.code).toBe(0);
});
