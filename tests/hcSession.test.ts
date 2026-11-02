import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { protectedVariables } from './hcIsolation.js';
import type { ProtectedVariable } from './hcIsolation.js';
import { inheritedVariables, startHcSession } from './hcSession.js';

const folderOf: Record<ProtectedVariable, string> = {
  HOME: 'home',
  XDG_RUNTIME_DIR: 'run',
  XDG_STATE_HOME: 'state',
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_CACHE_HOME: 'cache',
};

const allowedEnvironment = new Set([...inheritedVariables, ...protectedVariables, 'HC_SESSION']);

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

// Every exec succeeds with no output, so no unit test in this file starts the real hc.
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

it('does not inherit HC_ or HERDR_ variables in exec, connect, or stop', async () => {
  vi.stubEnv('HC_SOCKET', '/tmp/witness.sock');
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  vi.stubEnv('HERDR_PANE_ID', 'pane');

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
    expect(environment).not.toHaveProperty('HERDR_PANE_ID');
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
