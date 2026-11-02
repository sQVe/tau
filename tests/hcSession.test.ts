import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
  const execFileMock = vi.fn<typeof actual.execFile>(actual.execFile);
  const spawnMock = vi.fn<typeof actual.spawn>(actual.spawn);

  return {
    ...actual,
    execFile: execFileMock as unknown as typeof actual.execFile,
    spawn: spawnMock as unknown as typeof actual.spawn,
  };
});

const execFileMock = vi.mocked(execFile);
const spawnMock = vi.mocked(spawn);

beforeEach(() => {
  execFileMock.mockClear();
  spawnMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('refuses a default session and runs no hc command', async () => {
  const failure = await startHcSession({ session: 'default' }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('HC_SESSION');
  expect(execFileMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
});

it('builds a private environment for a generated session', async () => {
  const session = await startHcSession();

  try {
    expect(session.session).toMatch(/^tau-test-[0-9a-f]+$/);

    for (const name of protectedVariables) {
      expect(session.environment[name]).toBe(`${session.root}/${folderOf[name]}`);
    }

    for (const name of Object.keys(session.environment)) {
      expect(allowedEnvironment.has(name)).toBe(true);
    }
  } finally {
    rmSync(session.root, { recursive: true, force: true });
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
    const failure = await startHcSession().catch((error: unknown) => error);

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

  execFileMock.mockImplementation(((...argumentsList: unknown[]) => {
    const callback = argumentsList[3] as (error: null, stdout: string, stderr: string) => void;

    callback(null, '', '');

    return undefined;
  }) as unknown as typeof execFile);

  spawnMock.mockImplementationOnce(() => {
    throw new Error('connect stopped before spawn');
  });

  const session = await startHcSession();

  try {
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
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});
