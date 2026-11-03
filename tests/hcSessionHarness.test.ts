import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { runWithEnvironment } from '../src/hc/connect.js';
import { protectedVariables } from './hcIsolationHarness.js';
import type { ProtectedVariable } from './hcIsolationHarness.js';
import { inheritedVariables, sessionProcesses, startHcSession } from './hcSessionHarness.js';

interface FakeProcess {
  state: string;
  environment: string;
}

const folderOf: Record<ProtectedVariable, string> = {
  HOME: 'home',
  XDG_RUNTIME_DIR: 'run',
  XDG_STATE_HOME: 'state',
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_CACHE_HOME: 'cache',
};

const allowedEnvironment = new Set([...inheritedVariables, ...protectedVariables, 'HC_SESSION']);

// The /proc entries the off-Linux test reads through sessionProcesses.
const fakeProcesses = vi.hoisted(() => new Map<string, FakeProcess>());

const procFilePattern = /^\/proc\/(\d+)\/(stat|environ)$/;

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();

  const readdirFake = (path: string) =>
    path === '/proc' ? [...fakeProcesses.keys()] : actual.readdirSync(path);

  const readFileFake = (path: string, encoding: BufferEncoding) => {
    const match = procFilePattern.exec(path);
    const entry = match === null ? undefined : fakeProcesses.get(match[1] ?? '');

    if (match === null) {
      return actual.readFileSync(path, encoding);
    }

    if (entry === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }

    return match[2] === 'stat' ? `1 (hc) ${entry.state} 1 1 1` : entry.environment;
  };

  return {
    ...actual,
    readdirSync: readdirFake as unknown as typeof actual.readdirSync,
    readFileSync: readFileFake as unknown as typeof actual.readFileSync,
  };
});

const addFakeProcess = (processId: number, session: string): void => {
  fakeProcesses.set(String(processId), {
    state: 'S',
    environment: `PATH=/usr/bin\0HC_SESSION=${session}\0`,
  });

  onTestFinished(() => {
    fakeProcesses.clear();
  });
};

const addFakeProcessEnvironment = (
  processId: number,
  environment: Record<string, string>,
): void => {
  const entries = Object.entries(environment).map(([name, value]) => `${name}=${value}`);

  fakeProcesses.set(String(processId), {
    state: 'S',
    environment: `${entries.join('\0')}\0`,
  });

  onTestFinished(() => {
    fakeProcesses.clear();
  });
};

// The stop path polls with timers, so the tests drive them with fake time.
const useFakeTimersUntilFinished = (): void => {
  vi.useFakeTimers();

  onTestFinished(() => {
    vi.useRealTimers();
  });
};

const noProcesses = (): number[] => [];

// A session whose cleanup the test runs itself, because its stop is expected to fail.
const startUnregisteredSession = (
  listProcesses: (session: string) => number[] = noProcesses,
): ReturnType<typeof startHcSession> => startHcSession(() => undefined, { listProcesses });

const failingExecFile = (stderr: string, code: number): typeof execFile =>
  ((...argumentsList: unknown[]) => {
    const callback = argumentsList[3] as (error: Error, stdout: string, stderr: string) => void;

    callback(Object.assign(new Error('exited'), { code }), '', stderr);

    return undefined;
  }) as unknown as typeof execFile;

vi.mock(import('node:child_process'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    execFile: vi.fn<typeof actual.execFile>() as unknown as typeof actual.execFile,
    spawn: vi.fn<typeof actual.spawn>() as unknown as typeof actual.spawn,
  };
});

const execFileMock = vi.mocked(execFile);
const spawnMock = vi.mocked(spawn);

const succeedsWithoutOutput = ((...argumentsList: unknown[]) => {
  const callback = argumentsList[3] as (error: null, stdout: string, stderr: string) => void;

  callback(null, '', '');

  return undefined;
}) as unknown as typeof execFile;

beforeEach(() => {
  execFileMock.mockClear();
  execFileMock.mockImplementation(succeedsWithoutOutput);
  spawnMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('refuses a default session and runs no hc command', async () => {
  const failure = await startHcSession(onTestFinished, { session: 'default' }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('HC_SESSION');
  expect(execFileMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
});

it('builds a private environment for a generated session', async () => {
  const session = await startHcSession(onTestFinished);

  expect(session.session).toMatch(/^tau-test-[0-9a-f]+$/);

  for (const name of protectedVariables) {
    expect(session.environment[name]).toBe(`${session.root}/${folderOf[name]}`);
  }

  for (const name of Object.keys(session.environment)) {
    expect(allowedEnvironment.has(name)).toBe(true);
  }
});

it('refuses a temp root that resolves inside the real home', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'tau-hc-home-'));
  const realHome = join(outer, 'home');
  const alias = join(outer, 'alias');

  mkdirSync(realHome);
  symlinkSync(realHome, alias, 'dir');
  vi.stubEnv('HOME', realHome);
  vi.stubEnv('TMPDIR', alias);

  try {
    const failure = await startHcSession(onTestFinished).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('HOME is inside the real HOME');
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

it('does not inherit HC_ variables in exec, connect, or stop', async () => {
  vi.stubEnv('HC_SOCKET', '/tmp/witness.sock');
  vi.stubEnv('HC_TERMINAL_ID', 't7');

  spawnMock.mockImplementationOnce(() => {
    throw new Error('connect stopped before spawn');
  });

  const session = await startHcSession(onTestFinished);

  await session.runtime.exec('hc', ['server', 'status', '--json'], { cwd: session.root });
  await session.runtime.connect(['not-used']).catch(() => undefined);
  await session.stop();

  expect(execFileMock).toHaveBeenCalledTimes(2);
  expect(spawnMock).toHaveBeenCalledTimes(1);

  const environments = [
    (execFileMock.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined)?.env,
    (spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined)?.env,
    (execFileMock.mock.calls[1]?.[2] as { env?: Record<string, string> } | undefined)?.env,
  ];

  for (const environment of environments) {
    expect(environment).toBeDefined();
    expect(environment).not.toHaveProperty('HC_SOCKET');
    expect(environment).not.toHaveProperty('HC_TERMINAL_ID');
    expect(environment?.['HC_SESSION']).toBe(session.session);
  }
});

it('stops the core once when the caller and the registered cleanup both stop', async () => {
  const cleanups: (() => Promise<void>)[] = [];

  const registerCleanup = ((cleanup: () => Promise<void>) => {
    cleanups.push(cleanup);
  }) as unknown as TestContext['onTestFinished'];

  const session = await startHcSession(registerCleanup);

  await session.stop();
  await cleanups[0]?.();

  const stopCalls = execFileMock.mock.calls.filter(
    (callArguments) =>
      (callArguments[1] as string[] | undefined)?.join(' ') === 'server stop --json',
  );

  expect(cleanups).toHaveLength(1);
  expect(stopCalls).toHaveLength(1);
});

it('runs an exec with the cwd, signal, and timeout it was given', async () => {
  const session = await startHcSession(onTestFinished);
  const controller = new AbortController();

  await session.runtime.exec('hc', ['ls', '--json'], {
    cwd: '/elsewhere',
    signal: controller.signal,
    timeout: 1000,
  });

  const options = execFileMock.mock.calls[0]?.[2] as
    | { cwd?: string; signal?: AbortSignal; timeout?: number }
    | undefined;

  expect(options?.cwd).toBe('/elsewhere');
  expect(options?.signal).toBe(controller.signal);
  expect(options?.timeout).toBe(1000);
});

it('turns a non-zero exit into a result with its code', async () => {
  const session = await startHcSession(onTestFinished);

  execFileMock.mockImplementationOnce(((...argumentsList: unknown[]) => {
    const callback = argumentsList[3] as (error: Error, stdout: string, stderr: string) => void;

    callback(Object.assign(new Error('exited'), { code: 2 }), 'out', 'err');

    return undefined;
  }) as unknown as typeof execFile);

  const result = await session.runtime.exec('hc', ['ls', '--json'], { cwd: session.root });

  expect(result).toEqual({ code: 2, killed: false, stdout: 'out', stderr: 'err' });
});

it('refuses a session equal to the inherited HC_SESSION and runs no hc command', async () => {
  vi.stubEnv('HC_SESSION', 'tau-test-inherited');

  const failure = await startHcSession(onTestFinished, { session: 'tau-test-inherited' }).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('HC_SESSION equals the inherited HC_SESSION');
  expect(execFileMock).not.toHaveBeenCalled();
});

it('reports a command killed by its timeout as killed with its signal', async () => {
  const session = await startHcSession(onTestFinished);

  execFileMock.mockImplementationOnce(((...argumentsList: unknown[]) => {
    const callback = argumentsList[3] as (error: Error, stdout: string, stderr: string) => void;

    callback(
      Object.assign(new Error('timed out'), { code: null, killed: true, signal: 'SIGTERM' }),
      'out',
      'err',
    );

    return undefined;
  }) as unknown as typeof execFile);

  const result = await session.runtime.exec('hc', ['ls', '--json'], { cwd: session.root });

  expect(result).toEqual({
    code: 1,
    killed: true,
    stdout: 'out',
    stderr: 'err',
    signal: 'SIGTERM',
  });
});

it('rejects an aborted command', async () => {
  const session = await startHcSession(onTestFinished);

  execFileMock.mockImplementationOnce(((...argumentsList: unknown[]) => {
    const callback = argumentsList[3] as (error: Error, stdout: string, stderr: string) => void;

    callback(
      Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }),
      '',
      '',
    );

    return undefined;
  }) as unknown as typeof execFile);

  await expect(
    session.runtime.exec('hc', ['ls', '--json'], { cwd: session.root }),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

it('reports no session process off Linux', () => {
  addFakeProcess(4242, 'tau-test-other-platform');

  const original = Object.getOwnPropertyDescriptor(process, 'platform');

  Object.defineProperty(process, 'platform', { value: 'darwin' });

  onTestFinished(() => {
    if (original !== undefined) {
      Object.defineProperty(process, 'platform', original);
    }
  });

  expect(sessionProcesses('tau-test-other-platform')).toEqual([]);
});

it('bounds hc server stop with a timeout', async () => {
  const session = await startUnregisteredSession();

  await session.stop();

  const stopOptions = execFileMock.mock.calls[0]?.[2] as { timeout?: number } | undefined;

  expect(stopOptions?.timeout).toBeGreaterThan(0);
});

it('shares one stop between concurrent callers and makes the second wait for the first', async () => {
  const session = await startUnregisteredSession();
  let finishCallback: ((error: null, stdout: string, stderr: string) => void) | undefined;

  execFileMock.mockImplementationOnce(((...argumentsList: unknown[]) => {
    finishCallback = argumentsList[3] as (error: null, stdout: string, stderr: string) => void;

    return undefined;
  }) as unknown as typeof execFile);

  const settled = vi.fn<() => void>();
  const first = session.stop();
  const second = session.stop().then(settled);

  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  const settledBeforeFinish = settled.mock.calls.length;

  finishCallback?.(null, '', '');
  await Promise.all([first, second]);

  expect(settledBeforeFinish).toBe(0);
  expect(settled).toHaveBeenCalledOnce();

  expect(
    execFileMock.mock.calls.filter(([, args]) => args?.join(' ') === 'server stop --json'),
  ).toHaveLength(1);
});

it('removes the root after a failed hc server stop when no process remains', async () => {
  const session = await startUnregisteredSession();

  execFileMock.mockImplementationOnce(failingExecFile('boom\n', 1));

  const failure = await session.stop().catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('hc server stop failed: boom');
  expect(existsSync(session.root)).toBe(false);
});

it('stops a leftover core of its own session with the core paths and no PID signal', async () => {
  const remaining = new Set([4343]);
  const session = await startUnregisteredSession(() => [...remaining]);

  addFakeProcessEnvironment(4343, {
    PATH: '/usr/bin',
    HC_SESSION: session.session,
    XDG_RUNTIME_DIR: join(session.root, 'run'),
    XDG_STATE_HOME: join(session.root, 'state'),
  });

  const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

  onTestFinished(() => {
    killSpy.mockRestore();
  });

  const stopEnvironments: (Record<string, string> | undefined)[] = [];

  execFileMock.mockImplementation(((...argumentsList: unknown[]) => {
    const options = argumentsList[2] as { env?: Record<string, string> } | undefined;
    const callback = argumentsList[3] as (error: null, stdout: string, stderr: string) => void;

    stopEnvironments.push(options?.env);
    callback(null, '', '');

    if (stopEnvironments.length >= 2) {
      remaining.clear();
    }

    return undefined;
  }) as unknown as typeof execFile);

  useFakeTimersUntilFinished();

  const stopping = session.stop();

  await vi.runAllTimersAsync();
  await stopping;

  expect(killSpy).not.toHaveBeenCalled();
  expect(stopEnvironments).toHaveLength(2);

  expect(stopEnvironments[1]).toMatchObject({
    HC_SESSION: session.session,
    XDG_RUNTIME_DIR: join(session.root, 'run'),
    XDG_STATE_HOME: join(session.root, 'state'),
  });

  expect(existsSync(session.root)).toBe(false);
});

it('refuses to stop a leftover process whose environment is not the test session', async () => {
  const session = await startUnregisteredSession(() => [4343]);

  addFakeProcessEnvironment(4343, {
    PATH: '/usr/bin',
    HC_SESSION: 'other-session',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_STATE_HOME: '/home/other/.local/state',
  });

  onTestFinished(() => {
    rmSync(session.root, { recursive: true, force: true });
  });

  const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

  onTestFinished(() => {
    killSpy.mockRestore();
  });

  useFakeTimersUntilFinished();

  const stopping = session.stop().catch((error: unknown) => error);

  await vi.runAllTimersAsync();

  const failure = await stopping;

  expect(failure).toBeInstanceOf(Error);

  expect((failure as Error).message).toBe(
    `hc session ${session.session} still has processes after stop; kept ${session.root}`,
  );

  expect(
    execFileMock.mock.calls.filter(([, args]) => args?.join(' ') === 'server stop --json'),
  ).toHaveLength(1);

  expect(killSpy).not.toHaveBeenCalled();
  expect(existsSync(session.root)).toBe(true);
});

it('refuses a terminal run with a real protected path before starting a process', async () => {
  const session = await startHcSession(onTestFinished);

  await expect(
    runWithEnvironment(session.runtime, {
      argv: ['true'],
      env: { ...session.environment, HOME: homedir() },
    }),
  ).rejects.toThrow('HOME');

  expect(spawnMock).not.toHaveBeenCalled();
});
