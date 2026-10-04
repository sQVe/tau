import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

import { resolveReadPath } from './readPath.js';

const cwd = '/work/project';

it.for([
  { spelling: 'a relative path', path: 'skills/SKILL.md', expected: join(cwd, 'skills/SKILL.md') },
  { spelling: 'an @ prefix', path: '@skills/SKILL.md', expected: join(cwd, 'skills/SKILL.md') },
  { spelling: 'a ~ prefix', path: '~/SKILL.md', expected: join(homedir(), 'SKILL.md') },
  {
    spelling: 'a file URL',
    path: pathToFileURL('/other/my skill/SKILL.md').href,
    expected: resolve('/other/my skill/SKILL.md'),
  },
])('resolves $spelling the way Pi reads it', ({ path, expected }) => {
  expect(resolveReadPath(cwd, path)).toBe(expected);
});
