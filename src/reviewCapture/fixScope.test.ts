import { expect, it } from 'vitest';

import { decideFixScope } from './fixScope.js';

it.each([
  { name: 'an empty fix', fixPaths: [], findingPaths: ['a.ts'], scope: 'fix', outside: [] },
  {
    name: 'a fix inside the findings',
    fixPaths: ['a.ts'],
    findingPaths: ['a.ts', 'b.ts'],
    scope: 'fix',
    outside: [],
  },
  {
    name: 'a fix with no findings',
    fixPaths: ['a.ts'],
    findingPaths: [],
    scope: 'wholeTarget',
    outside: ['a.ts'],
  },
  {
    name: 'a fix that adds one file',
    fixPaths: ['a.ts', 'c.ts'],
    findingPaths: ['a.ts'],
    scope: 'wholeTarget',
    outside: ['c.ts'],
  },
  {
    name: 'a fix that adds two files, in fix order',
    fixPaths: ['z.ts', 'a.ts', 'b.ts'],
    findingPaths: ['b.ts'],
    scope: 'wholeTarget',
    outside: ['z.ts', 'a.ts'],
  },
  {
    name: 'a path that only shares a prefix',
    fixPaths: ['src/a.ts'],
    findingPaths: ['src'],
    scope: 'wholeTarget',
    outside: ['src/a.ts'],
  },
])('decides $name', ({ fixPaths, findingPaths, scope, outside }) => {
  expect(decideFixScope({ fixPaths, findingPaths })).toEqual({ scope, outsidePaths: outside });
});
