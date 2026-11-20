import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { architectLockPath } from '../src/extensions/architect/lock.js';
import { readLiveLockHolder } from '../src/fileLock/fileLock.js';
import { socketDirectoryFor, socketPathFor } from '../src/inbox/endpoint.js';
import { releaseRegistration } from '../src/inbox/inbox.js';
import tauRegistration from '../src/tau/tau.js';
import { succeededResult } from './execFake.js';
import { fakeExtensionApi } from './extensionApi.js';
import { createTemporaryRepository } from './gitRepository.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

type Handler = (event: never, context: ExtensionContext) => unknown;

interface Registration {
  index: number;
  name: string;
  handler: Handler;
  stack: string;
}

const requireRegistration = (
  registration: Registration | undefined,
  name: string,
): Registration => {
  if (registration === undefined) {
    throw new Error(`Tau did not register ${name}.`);
  }

  return registration;
};

const waitForMissing = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!existsSync(path)) {
      return;
    }

    await sleep(10);
  }
};

it('inbox closes before the lock frees', async ({ onTestFinished }) => {
  releaseRegistration();

  const uid = process.getuid?.();

  if (uid === undefined) {
    throw new Error('The inbox shutdown test needs a POSIX user ID.');
  }

  const root = await createTemporaryRepository(onTestFinished);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shutdown-');
  const sessionId = 'shutdown-test-session';
  const socketPath = socketPathFor(socketDirectoryFor(uid), sessionId);
  const lockPath = architectLockPath(root);
  const processGroup = 100;
  const withdrawalStarted = Promise.withResolvers<undefined>();
  const releaseWithdrawal = Promise.withResolvers<undefined>();
  let holdWithdrawal = false;

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('TAU_ROLE', 'architect');
  vi.stubEnv('TAU_ARCHITECT_ASK', '');
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  const fake = fakeExtensionApi({
    exec: async (command, commandArguments) => {
      if (command === 'ps') {
        return succeededResult(`${String(processGroup)}\n`);
      }

      if (holdWithdrawal && commandArguments[0] === 'get') {
        holdWithdrawal = false;
        withdrawalStarted.resolve(undefined);
        await releaseWithdrawal.promise;
      }

      const labels = { 'tau.inbox': `rpc1:${socketPath}` };
      const foreground = { pid: processGroup, name: 'pi', argv: ['pi'], cwd: root };
      const terminal = { address: 't-architect', state: 'live', foreground, labels };

      return succeededResult(JSON.stringify(terminal));
    },
  });

  const registered: Registration[] = [];
  const on = fake.pi.on.bind(fake.pi) as (name: string, handler: Handler) => unknown;

  fake.pi.on = ((name: string, handler: Handler) => {
    registered.push({
      index: registered.length,
      name,
      handler,
      stack: new Error('handler registration').stack ?? '',
    });

    on(name, handler);
  }) as unknown as typeof fake.pi.on;

  await tauRegistration(fake.pi);

  const fromFile = (name: string, file: string): Registration[] =>
    registered.filter((entry) => entry.name === name && entry.stack.includes(file));

  const inboxStart = requireRegistration(
    fromFile('session_start', 'extensions/inbox/lifecycle.ts')[0],
    'the inbox session start',
  );

  const architectStart = requireRegistration(
    fromFile('session_start', 'extensions/architect/architect.ts')[0],
    'the architect session start',
  );

  const inboxShutdown = requireRegistration(
    fromFile('session_shutdown', 'extensions/inbox/lifecycle.ts')[0],
    'the inbox session shutdown',
  );

  const architectShutdown = requireRegistration(
    fromFile('session_shutdown', 'extensions/architect/architect.ts')[0],
    'the architect session shutdown',
  );

  const context = {
    cwd: root,
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    shutdown: vi.fn<() => void>(),
    isProjectTrusted: (): boolean => true,
    sessionManager: {
      getSessionFile: () => join(root, 'architect-session.jsonl'),
      getSessionId: () => sessionId,
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;

  await inboxStart.handler({} as never, context);
  await architectStart.handler({} as never, context);

  expect(existsSync(socketPath)).toBe(true);
  expect(await readLiveLockHolder(lockPath)).toBeDefined();

  onTestFinished(async () => {
    releaseWithdrawal.resolve(undefined);
    await waitForMissing(socketPath);
    releaseRegistration();
    vi.unstubAllEnvs();
  });

  expect(inboxShutdown.index).toBeLessThan(architectShutdown.index);

  holdWithdrawal = true;

  const inboxDone = Promise.resolve(inboxShutdown.handler({} as never, context));

  const outcome = await Promise.race([
    withdrawalStarted.promise.then(() => 'withdrawal'),
    inboxDone.then(() => 'done'),
  ]);

  expect(outcome).toBe('withdrawal');
  expect(existsSync(socketPath)).toBe(false);
  expect(await readLiveLockHolder(lockPath)).toBeDefined();

  releaseWithdrawal.resolve(undefined);
  await inboxDone;
  await architectShutdown.handler({} as never, context);

  expect(existsSync(socketPath)).toBe(false);
  expect(await readLiveLockHolder(lockPath)).toBeUndefined();
});
