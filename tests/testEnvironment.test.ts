import { expect, it } from 'vitest';

it('does not inherit the shell subagent capacity in test workers', () => {
  expect(process.env.TAU_SUBAGENT_CAP).toBeUndefined();
});
