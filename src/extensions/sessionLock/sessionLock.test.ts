import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { fauxProvider } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionUIContext,
  SessionBeforeSwitchEvent,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { exitedPid } from '../../../tests/exitedPid.js';
import { createPiSession, shutdownSession } from '../../../tests/piSession.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { holdFileLock, readLiveLockHolder } from '../../fileLock/fileLock.js';
import { sessionLockPath } from './hold.js';
import sessionLockExtension from './sessionLock.js';

type Cleanup = TestContext['onTestFinished'];

interface Harness {
  agentDirectory: string;
  sessionFile: string;
  session: AgentSession;
  notices: { message: string; type: string | undefined }[];
  shutdowns: string[];
  laterCalls: string[];
  binding: Promise<void>;
}

// Pi appends a model and a thinking level entry to a file with no messages, before any extension
// runs, so the fixture holds a message.
const sessionContent = (directory: string): string => {
  const timestamp = new Date(0).toISOString();

  const entries = [
    { type: 'session', version: 3, id: 'locked-session', timestamp, cwd: directory },
    {
      type: 'model_change',
      id: 'aaaaaaaa',
      parentId: null,
      timestamp,
      provider: 'faux',
      modelId: 'faux-1',
    },
    {
      type: 'thinking_level_change',
      id: 'bbbbbbbb',
      parentId: 'aaaaaaaa',
      timestamp,
      thinkingLevel: 'off',
    },
    {
      type: 'message',
      id: 'cccccccc',
      parentId: 'bbbbbbbb',
      timestamp,
      message: { role: 'user', content: 'Hello', timestamp: 0 },
    },
  ];

  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
};

const startSession = async (
  onTestFinished: Cleanup,
  options: { prepare?: (lockPath: string) => Promise<void>; inMemory?: boolean } = {},
): Promise<Harness> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-session-lock-');
  const agentDirectory = join(directory, 'agent');
  const sessionFile = join(directory, 'session.jsonl');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  writeFileSync(sessionFile, sessionContent(directory));

  const lockPath = await sessionLockPath(agentDirectory, sessionFile);

  await options.prepare?.(lockPath);

  const notices: Harness['notices'] = [];
  const shutdowns: string[] = [];
  const laterCalls: string[] = [];

  const laterExtension = (pi: ExtensionAPI): void => {
    pi.on('session_start', () => {
      laterCalls.push('session_start');
    });
  };

  const uiContext = {
    notify: (message: string, type?: string) => {
      notices.push({ message, type });
    },
  } as unknown as ExtensionUIContext;

  const sessionManager =
    options.inMemory === true
      ? SessionManager.inMemory(directory)
      : SessionManager.open(sessionFile);

  const { session } = await createPiSession(onTestFinished, {
    cwd: directory,
    agentDirectory,
    providers: [fauxProvider()],
    extensionFactories: [sessionLockExtension, laterExtension],
    sessionManager,
  });

  const binding = session.bindExtensions({
    uiContext,
    shutdownHandler: () => {
      shutdowns.push('shutdown');
    },
    onError: () => undefined,
  });

  return { agentDirectory, sessionFile, session, notices, shutdowns, laterCalls, binding };
};

const writeLockRecord = async (lockPath: string, pid: number): Promise<void> => {
  await mkdir(dirname(lockPath), { recursive: true });

  await writeFile(
    `${lockPath}.1`,
    JSON.stringify({
      pid,
      checkout: '/other',
      startedAt: new Date().toISOString(),
      token: 'other',
      terminal: 't42',
    }),
  );
};

it('refuses a session file another live Pi holds before later handlers run', async ({
  onTestFinished,
}) => {
  const harness = await startSession(onTestFinished, {
    prepare: async (lockPath) => {
      const held = await holdFileLock({ lockPath, checkout: '/other', terminal: 't42' });

      onTestFinished(async () => {
        if (held.kind === 'held') {
          await held.release();
        }
      });
    },
  });

  await vi.waitFor(() => {
    expect(harness.shutdowns).toEqual(['shutdown']);
  });

  const [notice] = harness.notices;

  expect(harness.notices).toHaveLength(1);
  expect(notice?.type).toBe('error');
  expect(notice?.message).toContain('t42');
  expect(notice?.message).toContain(harness.sessionFile);
  expect(harness.laterCalls).toEqual([]);

  expect(readFileSync(harness.sessionFile, 'utf8')).toBe(
    sessionContent(dirname(harness.sessionFile)),
  );

  await shutdownSession(harness.session);
});

it('starts on a session file whose old Pi exited', async ({ onTestFinished }) => {
  const pid = await exitedPid();

  const harness = await startSession(onTestFinished, {
    prepare: (lockPath) => writeLockRecord(lockPath, pid),
  });

  await harness.binding;

  const lockPath = await sessionLockPath(harness.agentDirectory, harness.sessionFile);

  expect(harness.shutdowns).toEqual([]);
  expect(harness.laterCalls).toEqual(['session_start']);
  expect(await readLiveLockHolder(lockPath)).toMatchObject({ pid: process.pid });
});

it('frees the lock on session shutdown', async ({ onTestFinished }) => {
  const harness = await startSession(onTestFinished);

  await harness.binding;

  const lockPath = await sessionLockPath(harness.agentDirectory, harness.sessionFile);

  expect(await readLiveLockHolder(lockPath)).toMatchObject({ pid: process.pid });

  await shutdownSession(harness.session);

  expect(await readLiveLockHolder(lockPath)).toBeUndefined();
});

it('cancels resume onto a session file another live Pi holds', async ({ onTestFinished }) => {
  const harness = await startSession(onTestFinished);

  await harness.binding;

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });

  onTestFinished(() => {
    child.kill();
  });

  const target = join(dirname(harness.sessionFile), 'target.jsonl');
  const free = join(dirname(harness.sessionFile), 'free.jsonl');

  await writeLockRecord(await sessionLockPath(harness.agentDirectory, target), child.pid ?? 0);

  const emitResume = (targetSessionFile: string) =>
    harness.session.extensionRunner.emit({
      type: 'session_before_switch',
      reason: 'resume',
      targetSessionFile,
    } satisfies SessionBeforeSwitchEvent);

  expect(await emitResume(target)).toEqual({ cancel: true });

  expect(harness.notices.map((notice) => notice.message)).toEqual([
    expect.stringContaining(target),
  ]);

  expect(harness.notices[0]?.message).toContain('t42');

  expect(await emitResume(free)).toBeUndefined();
  expect(harness.notices).toHaveLength(1);
});

it.for([
  { name: 'a new session', reason: 'new', hasTarget: true },
  { name: 'a resume with no target file', reason: 'resume', hasTarget: false },
] as const)(
  'does not cancel $name even when a live Pi holds the target',
  async ({ reason, hasTarget }, { onTestFinished }) => {
    const harness = await startSession(onTestFinished);

    await harness.binding;

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });

    onTestFinished(() => {
      child.kill();
    });

    const target = join(dirname(harness.sessionFile), 'target.jsonl');

    await writeLockRecord(await sessionLockPath(harness.agentDirectory, target), child.pid ?? 0);

    const result = await harness.session.extensionRunner.emit({
      type: 'session_before_switch',
      reason,
      ...(hasTarget ? { targetSessionFile: target } : {}),
    } satisfies SessionBeforeSwitchEvent);

    expect(result).toBeUndefined();
    expect(harness.notices).toEqual([]);
  },
);

it('starts with no lock when the session has no file', async ({ onTestFinished }) => {
  const harness = await startSession(onTestFinished, { inMemory: true });

  await harness.binding;

  expect(harness.shutdowns).toEqual([]);
  expect(harness.laterCalls).toEqual(['session_start']);
  expect(existsSync(join(harness.agentDirectory, 'tau', 'session-locks'))).toBe(false);
});

it('warns and starts when the lock folder cannot be made', async ({ onTestFinished }) => {
  const harness = await startSession(onTestFinished, {
    prepare: async (lockPath) => {
      const tauDirectory = dirname(dirname(dirname(lockPath)));

      await mkdir(dirname(tauDirectory), { recursive: true });
      await writeFile(tauDirectory, 'a file where the folder belongs');
    },
  });

  await harness.binding;

  expect(harness.shutdowns).toEqual([]);
  expect(harness.laterCalls).toEqual(['session_start']);
  expect(harness.notices.map((notice) => notice.type)).toEqual(['warning']);
});
