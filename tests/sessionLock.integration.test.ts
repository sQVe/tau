import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { fauxProvider } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { sessionLockPath } from '../src/extensions/sessionLock/hold.js';
import { holdFileLock } from '../src/fileLock/fileLock.js';
import { get, kill, run } from '../src/hc/hc.js';
import tauExtension from '../src/tau.js';
import { exitedPid } from './exitedPid.js';
import { startHcSession } from './hcSessionHarness.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createPiSession, shutdownSession } from './piSession.js';

const onLinux = process.platform === 'linux';

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

const startTauOnSessionFile = async (prepare: (lockPath: string) => Promise<void>) => {
  const hc = await startHcSession(onTestFinished);
  const { address: terminal } = await run(hc.runtime, { argv: ['sleep', '60'], background: true });

  onTestFinished(async () => {
    await kill(hc.runtime, terminal).catch(() => undefined);
  });

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  for (const [name, value] of Object.entries(hc.environment)) {
    vi.stubEnv(name, value);
  }

  vi.stubEnv('HC_TERMINAL_ID', terminal);

  const agentDirectory = join(hc.root, 'agent');
  const sessionFile = join(hc.root, 'session.jsonl');

  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(sessionFile, sessionContent(hc.root));
  isolateWebAccessConfig(agentDirectory, onTestFinished);

  await prepare(await sessionLockPath(agentDirectory, sessionFile));

  const { session } = await createPiSession(onTestFinished, {
    cwd: hc.root,
    agentDirectory,
    providers: [fauxProvider()],
    extensionFactories: [tauExtension],
    sessionManager: SessionManager.open(sessionFile),
  });

  const shutdowns: string[] = [];

  const binding = session.bindExtensions({
    shutdownHandler: () => {
      shutdowns.push('shutdown');
    },
    onError: () => undefined,
  });

  const inboxLabel = async (): Promise<string | undefined> =>
    (await get(hc.runtime, terminal)).labels?.['tau.inbox'];

  return { session, binding, shutdowns, inboxLabel };
};

it.skipIf(!onLinux)(
  'a resumed session whose old Pi exited advertises its inbox',
  async () => {
    const pid = await exitedPid();

    const started = await startTauOnSessionFile(async (lockPath) => {
      const lockDirectory = join(lockPath, '..');

      mkdirSync(lockDirectory, { recursive: true });

      writeFileSync(
        `${lockPath}.1`,
        JSON.stringify({
          pid,
          checkout: '/gone',
          startedAt: new Date().toISOString(),
          token: 'gone',
        }),
      );
    });

    await started.binding;

    await vi.waitFor(async () => {
      expect(await started.inboxLabel()).toMatch(/^rpc1:/u);
    });

    expect(started.shutdowns).toEqual([]);

    await shutdownSession(started.session);
  },
  60_000,
);

it.skipIf(!onLinux)(
  'a session file another live Pi holds gets no inbox',
  async () => {
    const started = await startTauOnSessionFile(async (lockPath) => {
      const held = await holdFileLock({ lockPath, checkout: '/other', terminal: 't42' });

      onTestFinished(async () => {
        if (held.kind === 'held') {
          await held.release();
        }
      });
    });

    await vi.waitFor(() => {
      expect(started.shutdowns).toEqual(['shutdown']);
    });

    await delay(300);

    expect(await started.inboxLabel()).toBeUndefined();

    await shutdownSession(started.session);
  },
  60_000,
);
