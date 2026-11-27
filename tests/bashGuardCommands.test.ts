import { expect, it } from 'vitest';

import { blockedOutputReason } from './bashGuardCommands.js';

it('accepts only a reason the guard itself produces', () => {
  expect(
    blockedOutputReason({ block: true, reason: 'write a log such as /tmp/<name>.log first' }),
  ).toBeUndefined();
});
