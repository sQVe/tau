import { expect, it } from 'vitest';

import { worktreePath } from './worktreePath.js';

it.each([
  { fromSession: 'src/value.ts', fromCanonical: '../real/src/value.ts', path: 'src/value.ts' },
  { fromSession: '../linked/src/value.ts', fromCanonical: 'src/value.ts', path: 'src/value.ts' },
  { fromSession: '..', fromCanonical: 'real', path: 'real' },
  { fromSession: '..src/value.ts', fromCanonical: '../a/..src/value.ts', path: '..src/value.ts' },
  { fromSession: '../outside.ts', fromCanonical: '../outside.ts', path: '../outside.ts' },
])('classifies $fromSession by its worktree path $path', ({ fromSession, fromCanonical, path }) => {
  expect(worktreePath(fromSession, fromCanonical)).toBe(path);
});
