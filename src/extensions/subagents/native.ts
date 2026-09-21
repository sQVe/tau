import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { requireNativeTask } from './types.js';
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

export const nativeHeader = (file: string) => readNative(file).header;

export const validateNative = (task: Task, origin: Task) => {
  const saved = requireNativeTask(task);

  try {
    const native = readNative(saved.nativeSessionFile);

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
