import { expect, it } from 'vitest';

import { signalActiveGenerationRead } from './sweepLockRead.js';

it('refuses to watch a lock read when node:fs/promises is not mocked', () => {
  expect(() => signalActiveGenerationRead('/agent', 1)).toThrow(
    'signalActiveGenerationRead needs the importing test file to mock node:fs/promises.',
  );
});
