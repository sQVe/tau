import { expect, it } from 'vitest';

import { createBindingScopes } from './pureModuleScopes.js';

it('refuses to pop the root binding scope', () => {
  const scopes = createBindingScopes();

  expect(() => {
    scopes.exit();
  }).toThrow('the binding scope stack would empty');
});
