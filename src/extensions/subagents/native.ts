import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readClaudeNative } from './claude.js';
import { isClaudeLoadout } from './types.js';
import type { Task } from './types.js';

const headerSchema = Type.Object({
  type: Type.Literal('session'),
  version: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  id: Type.String({ minLength: 1 }),
  parentSession: Type.Optional(Type.String({ minLength: 1 })),
  cwd: Type.Optional(Type.String()),
});

export const readNative = (path: string) => {
  // Nonblocking open prevents a substituted FIFO from hanging prevalidation. Do not follow replacement symlinks.
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) {
      throw new Error('Native session must be an existing regular file.');
    }
    const buffer = Buffer.alloc(64_001);
    let length = 0;
    while (length < buffer.length && buffer.subarray(0, length).indexOf(10) === -1) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!count) {
        break;
      }
      length += count;
    }
    const newline = buffer.subarray(0, length).indexOf(10);
    const end = newline === -1 ? length : newline;
    if (end > 64_000) {
      throw new Error('Session lineage header exceeds 64 KB.');
    }
    const header: unknown = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    if (!Value.Check(headerSchema, header)) {
      throw new Error('Invalid or unsupported native session lineage header.');
    }

    return {
      header,
      identity: {
        device: String(stat.dev),
        inode: String(stat.ino),
        size: String(stat.size),
        modified: String(stat.mtimeNs),
      },
    };
  } finally {
    closeSync(descriptor);
  }
};

// Claude writes its own transcript without Tau's lineage header, so the saved task carries that lineage.
export const nativeHeader = (file: string, task?: Task) => {
  if (task && isClaudeLoadout(task.loadout)) {
    return {
      type: 'session' as const,
      version: 3 as const,
      id: readClaudeNative(file).sessionId,
      cwd: task.loadout.cwd,
      parentSession: task.parentSession,
    };
  }

  return readNative(file).header;
};

export const validateNative = (task: Task, origin: Task) => {
  if (isClaudeLoadout(task.loadout)) {
    try {
      const native = readClaudeNative(task.nativeSessionFile);
      if (native.sessionId !== task.nativeSessionId) {
        throw new Error('Native identity changed.');
      }

      return {
        header: {
          type: 'session' as const,
          version: 3 as const,
          id: native.sessionId,
          cwd: task.loadout.cwd,
          parentSession: origin.parentSession,
        },
        identity: native.identity,
      };
    } catch (error) {
      throw new Error(`Native follow-up prevalidation refused: ${String(error)}`, { cause: error });
    }
  }

  try {
    const native = readNative(task.nativeSessionFile);
    if (
      native.header.id !== task.nativeSessionId ||
      native.header.cwd !== task.loadout.cwd ||
      native.header.parentSession !== origin.parentSession
    ) {
      throw new Error('Native identity, cwd, or original lineage changed.');
    }

    return native;
  } catch (error) {
    throw new Error(`Native follow-up prevalidation refused: ${String(error)}`, { cause: error });
  }
};
