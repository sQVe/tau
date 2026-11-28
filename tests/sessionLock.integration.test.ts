import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { fauxProvider } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { holdFileLock } from '../src/fileLock/fileLock.js';
import { get, kill, run } from '../src/hc/hc.js';
import { sessionLockPath } from '../src/sessionLock/sessionLock.js';
import tauRegistration from '../src/tau/tau.js';
import { exitedPid } from './exitedPid.js';
import { startHcSession } from './hcSessionHarness.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { writeLockOwnerRecord } from './lockOwnerRecord.js';
import { createPiSession, shutdownSession } from './piSession.js';
import { seedSavedSession } from './savedSession.js';

const onLinux = process.platform === 'linux';

// The test process is not the foreground process of its hc terminal, so full Tau would not own it.
const terminalForeground = vi.hoisted(() => ({ pid: 0 }));

vi.mock(import('../src/extensions/inbox/processGroup.js'), () => ({
  readProcessGroup: () => Promise.resolve(terminalForeground.pid),
}));

const startTauOnSessionFile = async (prepare: (lockPath: string) => Promise<void>) => {
  const hc = await startHcSession(onTestFinished);
  const { address: terminal } = await run(hc.runtime, { argv: ['sleep', '60'], background: true });

  onTestFinished(async () => {
    await kill(hc.runtime, terminal).catch(() => undefined);
  });

  const foreground = await vi.waitFor(async () => {
    const reply = await get(hc.runtime, terminal);

    if (reply.foreground === undefined || reply.foreground === null) {
      throw new Error(`Terminal ${terminal} reports no foreground process.`);
    }

    return reply.foreground;
  });

  terminalForeground.pid = foreground.pid;

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  for (const [name, value] of Object.entries(hc.environment)) {
    vi.stubEnv(name, value);
  }

  vi.stubEnv('HC_TERMINAL_ID', terminal);

  const agentDirectory = join(hc.root, 'agent');

  mkdirSync(agentDirectory, { recursive: true });
  const sessionFile = seedSavedSession(hc.root);
  isolateWebAccessConfig(agentDirectory, onTestFinished);

  await prepare(await sessionLockPath(agentDirectory, sessionFile));

  const { session } = await createPiSession(onTestFinished, {
    cwd: hc.root,
    agentDirectory,
    providers: [fauxProvider()],
    extensionFactories: [tauRegistration],
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
      await writeLockOwnerRecord(lockPath, { pid, checkout: '/gone', token: 'gone' });
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
