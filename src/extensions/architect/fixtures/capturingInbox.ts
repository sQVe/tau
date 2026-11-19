import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import type { onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { createReceiptStore, createReceiver } from '../../../inbox/inbox.js';
import { decodeRequest, encodeFrame, refusedReply } from '../../../inbox/protocol.js';

type Cleanup = typeof onTestFinished;

export interface CapturingInbox {
  path: string;
  frames: string[];
  saved: () => string[];
  savedTexts: () => string[];
  releaseFirst: () => void;
  // Sets the mode for every frame after the first.
  replyLater: (mode: ReplyMode) => void;
}

export type ReplyMode = 'suppress' | 'hold' | 'reply' | 'save-then-drop';

const readdirSyncSafe = (path: string): string[] => {
  try {
    return readdirSync(path).map(String);
  } catch {
    return [];
  }
};

export const startCapturingInbox = async (
  cleanup: Cleanup,
  sessionId: string,
  first: ReplyMode,
  beforeReply?: (messageId: string) => Promise<void>,
  terminal = 't-architect',
): Promise<CapturingInbox> => {
  const directory = join(temporaryDirectory(cleanup, 'tau-capturing-'), 'sockets');
  const records = join(directory, '..', 'records');
  const frames: string[] = [];
  let release: (() => void) | undefined;
  let later: ReplyMode = 'reply';

  const receiver = createReceiver({
    directory: join(records, sessionId),
    terminal,
    sessionId,
    accepts: {
      handover: (_request, save) => save(),
      'architect-ask': (_request, save) => save(),
    },
    receipts: createReceiptStore(sessionId),
    entries: () => [],
    wake: () => true,
    notify: () => undefined,
  });

  mkdirSync(directory, { recursive: true });

  const path = join(directory, `${sessionId}.sock`);

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let data = '';

    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      data += chunk;
    });

    socket.on('end', () => {
      frames.push(data);

      const mode = frames.length === 1 ? first : later;

      if (mode === 'suppress' || mode === 'hold') {
        const finish = (): void => {
          socket.end();
        };

        if (mode === 'hold') {
          release = finish;
        } else {
          finish();
        }

        return;
      }

      (async () => {
        const decision = decodeRequest(Buffer.from(data));

        if (decision.kind === 'frame') {
          await beforeReply?.(decision.value.messageId);
        }

        const reply =
          decision.kind === 'frame'
            ? await receiver.accept(decision.value)
            : refusedReply(decision.reason);

        if (mode === 'save-then-drop') {
          socket.end();
        } else {
          socket.end(encodeFrame(reply));
        }
      })().catch(() => {
        socket.destroy();
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  cleanup(() => {
    server.close();
  });

  const saved = (): string[] =>
    readdirSyncSafe(join(records, sessionId)).filter((name) => name.endsWith('.json'));

  return {
    path,
    frames,
    saved,
    savedTexts: () =>
      saved().map((name) => {
        const record = JSON.parse(readFileSync(join(records, sessionId, name), 'utf8')) as {
          payload: { text: string };
        };

        return record.payload.text;
      }),
    releaseFirst: () => {
      release?.();
    },
    replyLater: (mode) => {
      later = mode;
    },
  };
};
