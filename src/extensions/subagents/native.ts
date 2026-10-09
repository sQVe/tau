import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import type { Task } from './types.js';

interface NativeSession {
  header: NativeHeader;
  identity: { device: string; inode: string; size: string; modified: string };
}

const latestSessionVersion = 3;
const headerByteLimit = 64_000;
const newlineByte = 0x0a;

const headerSchema = Type.Object({
  type: Type.Literal('session'),
  version: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(latestSessionVersion)]),
  id: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
});

type NativeHeader = Static<typeof headerSchema>;

const readNative = (path: string): NativeSession => {
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

    const buffer = Buffer.alloc(headerByteLimit + 1);
    let length = 0;

    while (length < buffer.length && buffer.subarray(0, length).indexOf(newlineByte) === -1) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);

      if (count === 0) {
        break;
      }

      length += count;
    }

    const newline = buffer.subarray(0, length).indexOf(newlineByte);
    const end = newline === -1 ? length : newline;

    if (end > headerByteLimit) {
      throw new Error('Native session header exceeds 64 KB.');
    }

    const header: unknown = JSON.parse(buffer.subarray(0, end).toString('utf8'));

    if (!Value.Check(headerSchema, header)) {
      throw new Error('Invalid or unsupported native session header.');
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

export const validateNative = (task: Task): NativeSession => {
  try {
    const native = readNative(task.nativeSessionFile);

    if (native.header.id !== task.nativeSessionId || native.header.cwd !== task.loadout.cwd) {
      throw new Error('Native identity or cwd changed.');
    }

    return native;
  } catch (error) {
    throw new Error(`Native follow-up prevalidation refused: ${String(error)}`, { cause: error });
  }
};
