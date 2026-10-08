import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Task } from '../types.js';

export interface NativeIdentity {
  nativeSessionId: string;
  nativeSessionFile: string;
}

export const seedSession = (task: Task): void => {
  const header = {
    type: 'session',
    version: 3,
    id: task.nativeSessionId,
    timestamp: new Date(task.createdAt).toISOString(),
    cwd: task.loadout.cwd,
    parentSession: task.parentSession,
  };

  writeFileSync(task.nativeSessionFile, `${JSON.stringify(header)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
};

export const nativeIdentity = (directory: string): NativeIdentity => {
  const nativeSessionId = randomUUID();

  return { nativeSessionId, nativeSessionFile: join(directory, `${nativeSessionId}.jsonl`) };
};
