import { expect, it } from 'vitest';

import strykerConfig from '../stryker.vitest.config.ts';

it('isolates test files in the mutation run', () => {
  expect(strykerConfig.test.isolate).toBe(true);
});
