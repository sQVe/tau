import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface NativeIdentity {
  nativeSessionId: string;
  nativeSessionFile: string;
}

export const nativeIdentity = (directory: string): NativeIdentity => {
  const nativeSessionId = randomUUID();

  return { nativeSessionId, nativeSessionFile: join(directory, `${nativeSessionId}.jsonl`) };
};
