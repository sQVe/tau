import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { FauxProviderHandle } from '@earendil-works/pi-ai';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { createInboxExtension } from '../src/extensions/inbox/inbox.js';
import { get, kill, label, run } from '../src/hc/hc.js';
import { sendInboxMessage } from '../src/inbox/inbox.js';
import { startHcSession } from './hcSessionHarness.js';
import type { HcSession } from './hcSessionHarness.js';
import { createPiSession, shutdownSession } from './piSession.js';

interface ReceiverSession {
  hc: HcSession;
  session: AgentSession;
  terminal: string;
  sessionId: string;
  path: string;
  socketRoot: string;
  savedRecords: () => string[];
  shownCount: (messageId: string) => number;
}

interface StartupHold {
  extension: (pi: ExtensionAPI) => void;
  reached: Promise<void>;
  release: () => void;
}

interface HeldProvider {
  provider: FauxProviderHandle;
  called: Promise<void>;
  release: () => void;
}

const onLinux = process.platform === 'linux';

const listenerCount = (path: string): number =>
  readFileSync('/proc/net/unix', 'utf8')
    .split('\n')
    .filter((line) => line.endsWith(` ${path}`))
    .filter((line) => line.split(/\s+/)[3] === '00010000').length;

const exchange = (path: string, request: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let reply = '';

    socket.setEncoding('utf8');

    socket.once('connect', () => {
      socket.end(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk: string) => {
      reply += chunk;
    });

    socket.once('close', () => {
      try {
        resolve(JSON.parse(reply));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.once('error', reject);
  });

const startupHold = (): StartupHold => {
  const reached = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  let held = false;

  return {
    extension: (pi) => {
      pi.on('session_start', async () => {
        if (held) {
          return;
        }

        held = true;
        reached.resolve(undefined);
        await released.promise;
      });
    },
    reached: reached.promise,
    release: () => {
      released.resolve(undefined);
    },
  };
};

const startReceiverSession = async (
  finished: typeof onTestFinished,
  provider: FauxProviderHandle,
  hold?: StartupHold,
): Promise<ReceiverSession> => {
  const hc = await startHcSession(onTestFinished);
  const { address: terminal } = await run(hc.runtime, { argv: ['sleep', '60'], background: true });

  onTestFinished(async () => {
    await kill(hc.runtime, terminal).catch(() => undefined);
  });

  const socketRoot = mkdtempSync('/tmp/tau-inbox-');

  chmodSync(socketRoot, 0o700);

  onTestFinished(() => {
    rmSync(socketRoot, { recursive: true, force: true });
  });

  const socketDirectory = join(socketRoot, 'sockets');
  const recordDirectory = join(socketRoot, 'records');

  vi.stubEnv('HC_TERMINAL_ID', terminal);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const inbox = createInboxExtension({
    hc: hc.runtime,
    socketDirectory: () => socketDirectory,
    inboxDirectory: () => recordDirectory,
  });

  const { session, extensionsResult } = await createPiSession(finished, {
    cwd: hc.root,
    agentDirectory: join(hc.root, 'agent'),
    providers: [provider],
    extensionFactories: hold === undefined ? [inbox] : [inbox, hold.extension],
  });

  expect(extensionsResult.errors).toEqual([]);

  const bound = session.bindExtensions({ onError: () => undefined });

  await (hold === undefined ? bound : hold.reached);

  const sessionId = session.sessionManager.getSessionId();

  const savedRecords = (): string[] => {
    try {
      return readdirSync(join(recordDirectory, sessionId));
    } catch {
      return [];
    }
  };

  const shownCount = (messageId: string): number =>
    session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === 'custom_message')
      .filter((entry) => entry.customType === 'tau-inbox-message')
      .filter((entry) => JSON.stringify(entry.details).includes(messageId)).length;

  return {
    hc,
    session,
    terminal,
    sessionId,
    path: join(socketDirectory, `${sessionId}.sock`),
    socketRoot,
    savedRecords,
    shownCount,
  };
};

const heldProvider = (): HeldProvider => {
  const provider = fauxProvider();
  const called = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();

  provider.setResponses([
    async () => {
      called.resolve(undefined);
      await released.promise;

      return fauxAssistantMessage('Read the handover.');
    },
  ]);

  return {
    provider,
    called: called.promise,
    release: () => {
      released.resolve(undefined);
    },
  };
};

const sendHandover = (receiver: ReceiverSession, messageId?: string) => {
  vi.stubEnv('HC_TERMINAL_ID', undefined);

  return sendInboxMessage({
    hc: receiver.hc.runtime,
    target: receiver.terminal,
    body: { family: 'handover', payload: { text: 'Continue the slice.' } },
    messageId,
    refusal: 'Nothing was queued.',
  });
};

const startReplyDroppingProxy = async (path: string, target: string): Promise<string[]> => {
  const dropped: string[] = [];

  const server = createServer({ allowHalfOpen: true }, (sender: Socket) => {
    const chunks: Buffer[] = [];

    sender.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    sender.once('end', () => {
      const receiver = createConnection(target);
      const reply: Buffer[] = [];

      receiver.once('connect', () => {
        receiver.end(Buffer.concat(chunks));
      });

      receiver.on('data', (chunk: Buffer) => {
        reply.push(chunk);
      });

      receiver.once('end', () => {
        dropped.push(Buffer.concat(reply).toString('utf8'));
        sender.destroy();
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );

  return dropped;
};

it.skipIf(!onLinux)(
  'keeps one listener across reload and removes socket and label at shutdown',
  async () => {
    const receiver = await startReceiverSession(() => undefined, fauxProvider());
    const { hc, session, terminal, sessionId, path } = receiver;

    const messageId = randomUUID();

    const answer = {
      protocol: 'rpc1',
      kind: 'message',
      messageId,
      targetTerminal: terminal,
      targetSessionId: sessionId,
      family: 'answer',
      payload: {
        assignmentId: randomUUID(),
        questionId: randomUUID(),
        parentSession: 'parent',
        answer: 'Use option A.',
      },
    };

    const refused = {
      protocol: 'rpc1',
      kind: 'refused',
      reason: 'This session does not accept answer messages.',
      messageId,
    };

    await expect(exchange(path, answer)).resolves.toEqual(refused);
    expect((await get(hc.runtime, terminal)).labels?.['tau.inbox']).toBe(`rpc1:${path}`);

    const socketBeforeReload = statSync(path).ino;

    // The link keeps the old socket's inode allocated, so a file system that reuses freed inodes
    // cannot give the new socket the same number.
    linkSync(path, join(receiver.socketRoot, 'before-reload.sock'));
    await session.reload();

    expect(statSync(path).ino).not.toBe(socketBeforeReload);
    await expect(exchange(path, answer)).resolves.toEqual(refused);
    expect(listenerCount(path)).toBe(1);
    expect((await get(hc.runtime, terminal)).labels?.['tau.inbox']).toBe(`rpc1:${path}`);

    await shutdownSession(session);

    expect(existsSync(path)).toBe(false);
    expect((await get(hc.runtime, terminal)).labels?.['tau.inbox']).toBeUndefined();
  },
);

it.skipIf(!onLinux)(
  'saves a handover before Pi shows it and deletes the record after Pi saved its receipt',
  async () => {
    const held = heldProvider();
    const hold = startupHold();
    const receiver = await startReceiverSession(onTestFinished, held.provider, hold);

    const sent = await sendHandover(receiver);

    expect(sent).toMatchObject({ status: 'queued', sessionId: receiver.sessionId });

    await delay(500);

    expect({
      records: receiver.savedRecords(),
      shown: receiver.shownCount(sent.messageId),
      modelCalls: held.provider.state.callCount,
    }).toEqual({ records: [`${sent.messageId}.json`], shown: 0, modelCalls: 0 });

    hold.release();

    await held.called;

    expect({
      records: receiver.savedRecords(),
      shown: receiver.shownCount(sent.messageId),
    }).toEqual({ records: [`${sent.messageId}.json`], shown: 1 });

    held.release();

    await vi.waitFor(() => {
      expect(receiver.savedRecords()).toEqual([]);
    });

    expect(receiver.shownCount(sent.messageId)).toBe(1);
  },
);

it.skipIf(!onLinux)(
  'stores and shows a message once when a retry reuses the ID of a lost reply',
  async () => {
    const held = heldProvider();
    const receiver = await startReceiverSession(onTestFinished, held.provider);
    const { hc, terminal, sessionId } = receiver;
    const proxyDirectory = join(receiver.socketRoot, 'proxy');

    mkdirSync(proxyDirectory, { mode: 0o700 });

    const proxyPath = join(proxyDirectory, `${sessionId}.sock`);

    const dropped = await startReplyDroppingProxy(proxyPath, receiver.path);
    await label(hc.runtime, terminal, { 'tau.inbox': `rpc1:${proxyPath}` });

    const lost = await sendHandover(receiver);

    expect(lost.status).toBe('unknown');

    expect(dropped.map((reply) => JSON.parse(reply) as unknown)).toEqual([
      {
        protocol: 'rpc1',
        kind: 'queued',
        messageId: lost.messageId,
        terminal,
        sessionId,
      },
    ]);

    await held.called;

    await label(hc.runtime, terminal, { 'tau.inbox': `rpc1:${receiver.path}` });

    const retried = await sendHandover(receiver, lost.messageId);

    expect(retried).toMatchObject({ status: 'queued', messageId: lost.messageId });

    held.release();

    await vi.waitFor(() => {
      expect(receiver.savedRecords()).toEqual([]);
    });

    expect({
      shown: receiver.shownCount(lost.messageId),
      modelCalls: held.provider.state.callCount,
    }).toEqual({ shown: 1, modelCalls: 1 });
  },
);

it.skipIf(!onLinux)(
  'stores nothing when the advertised socket refuses the connection',
  async () => {
    const held = heldProvider();
    const receiver = await startReceiverSession(onTestFinished, held.provider);
    const { hc, terminal, sessionId } = receiver;
    const staleDirectory = join(receiver.socketRoot, 'stale');

    mkdirSync(staleDirectory, { mode: 0o700 });

    const stalePath = join(staleDirectory, `${sessionId}.sock`);

    spawnSync(process.execPath, [
      '--eval',
      `require('node:net').createServer().listen(${JSON.stringify(stalePath)}, () => process.kill(process.pid, 'SIGKILL'))`,
    ]);

    await label(hc.runtime, terminal, { 'tau.inbox': `rpc1:${stalePath}` });

    const messageId = randomUUID();

    await expect(sendHandover(receiver, messageId)).rejects.toThrow('ECONNREFUSED');

    expect({
      records: receiver.savedRecords(),
      shown: receiver.shownCount(messageId),
      modelCalls: held.provider.state.callCount,
    }).toEqual({ records: [], shown: 0, modelCalls: 0 });
  },
);
