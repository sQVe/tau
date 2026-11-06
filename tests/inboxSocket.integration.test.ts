import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { fauxProvider } from '@earendil-works/pi-ai';
import { expect, it, onTestFinished, vi } from 'vitest';

import { createInboxExtension } from '../src/extensions/inbox/inbox.js';
import { get, kill, run } from '../src/hc/hc.js';
import { startHcSession } from './hcSessionHarness.js';
import { createBoundSession, shutdownSession } from './piSession.js';

// /proc/net/unix lists Unix sockets only on Linux.
const onLinux = process.platform === 'linux';

// A listening socket has the accept flag 00010000 in /proc/net/unix.
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

it.skipIf(!onLinux)(
  'keeps one listener across reload and removes socket and label at shutdown',
  async () => {
    const hc = await startHcSession(onTestFinished);
    const terminal = await run(hc.runtime, { argv: ['sleep', '60'], background: true });

    onTestFinished(async () => {
      await kill(hc.runtime, terminal.address).catch(() => undefined);
    });

    // Unix socket paths have a short byte limit, so the socket directory sits directly in /tmp.
    const socketRoot = mkdtempSync('/tmp/tau-inbox-');

    chmodSync(socketRoot, 0o700);

    onTestFinished(() => {
      rmSync(socketRoot, { recursive: true, force: true });
    });

    const socketDirectory = join(socketRoot, 'sockets');

    vi.stubEnv('HC_TERMINAL_ID', terminal.address);

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const { session } = await createBoundSession(
      () => undefined,
      {
        cwd: hc.root,
        agentDirectory: join(hc.root, 'agent'),
        providers: [fauxProvider()],
        extensionFactories: [
          createInboxExtension({
            hc: hc.runtime,
            socketDirectory: () => socketDirectory,
            inboxDirectory: () => join(socketRoot, 'records'),
          }),
        ],
      },
      // Pi's reload emits session_start only for a session with bindings.
      { onError: () => undefined },
    );

    const sessionId = session.sessionManager.getSessionId();
    const path = join(socketDirectory, `${sessionId}.sock`);

    const messageId = randomUUID();

    // The inbox checks the target before the family, so this refusal comes from this session's
    // listener, and nothing is saved or shown.
    const answer = {
      protocol: 'rpc1',
      kind: 'message',
      messageId,
      targetTerminal: terminal.address,
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
    expect((await get(hc.runtime, terminal.address)).labels?.['tau.inbox']).toBe(`rpc1:${path}`);

    const socketBeforeReload = statSync(path).ino;

    await session.reload();

    expect(statSync(path).ino).not.toBe(socketBeforeReload);
    await expect(exchange(path, answer)).resolves.toEqual(refused);
    expect(listenerCount(path)).toBe(1);
    expect((await get(hc.runtime, terminal.address)).labels?.['tau.inbox']).toBe(`rpc1:${path}`);

    await shutdownSession(session);

    expect(existsSync(path)).toBe(false);
    expect((await get(hc.runtime, terminal.address)).labels?.['tau.inbox']).toBeUndefined();
  },
);
