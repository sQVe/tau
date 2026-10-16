import { expect, it } from 'vitest';

import { closesLoop, createInputRules, unsupportedGlobReason } from './inputGlob.js';

it.each([
  { glob: 'src/**/*.{ts,tsx}', supported: true },
  { glob: './src/a?.ts', supported: true },
  { glob: '{./src,lib}/**', supported: true },
  { glob: '{a,{b,c}}/x', supported: true },
  { glob: 'src/{a,}.ts', supported: true },
  { glob: 'f{3..1}.ts', supported: true },
  { glob: 'f{0..1000}.ts', supported: false },
  { glob: 'f{1..1000}.ts', supported: true },
  { glob: 'f{1..1001}.ts', supported: false },
  { glob: 'f{1..1000}{1..2}.ts', supported: false },
  { glob: 'f{a..c}.ts', supported: false },
  { glob: 'f{-1..1}.ts', supported: false },
  { glob: 'f{01..03}.ts', supported: false },
  { glob: 'f{}.ts', supported: false },
  { glob: 'f{1,2.ts', supported: false },
  { glob: 'src/\\*.ts', supported: false },
  { glob: 'src/[ab][.ts', supported: false },
  { glob: 'src/[{}].ts', supported: false },
  { glob: 'src/../a.ts', supported: false },
])('classifies $glob as supported: $supported', ({ glob, supported }) => {
  expect(unsupportedGlobReason(glob) === null).toBe(supported);
});

const rules = (includeGlobs: string[], excludedGlobs: string[] = []) =>
  createInputRules(includeGlobs, excludedGlobs);

it.each([
  { globs: ['**/*.test.ts'], excludes: [], path: 'src/.test.ts', input: false },
  { globs: ['**/*.test.ts'], excludes: [], path: 'src/a.test.ts', input: true },
  { globs: ['**/foo.hidden/**/*.ts'], excludes: [], path: 'foo.hidden/.hidden/a.ts', input: false },
  { globs: ['{src,.config}/**'], excludes: [], path: '.config/a.ts', input: true },
  { globs: ['**/.env*'], excludes: [], path: 'src/.env.local', input: true },
  { globs: ['**/*.ts'], excludes: [], path: '.hidden/a.ts', input: false },
  { globs: ['./src/**/*.ts'], excludes: [], path: 'src/a.ts', input: true },
  { globs: ['f{1..3}.ts'], excludes: [], path: 'f2.ts', input: true },
  { globs: ['f{1..3}.ts'], excludes: [], path: 'f4.ts', input: false },
  { globs: ['src/*.ts'], excludes: [], path: 'src/a\nb.ts', input: true },
  { globs: ['src/?.ts'], excludes: [], path: 'src/\u{1F600}.ts', input: false },
  { globs: ['src/*.ts'], excludes: [], path: 'src/\u{1F600}.ts', input: true },
  { globs: ['src/**/*.ts'], excludes: ['**/x'], path: 'src/a.ts', input: true },
  { globs: ['src/**/*.ts'], excludes: ['src'], path: 'src/a.ts', input: true },
  { globs: ['**/*.ts'], excludes: ['**/a.ts'], path: 'src/a.ts', input: false },
  { globs: ['.hidden/**/*.ts'], excludes: [], path: '.hidden/value.ts', input: true },
  { globs: ['.hidden/**/*.ts'], excludes: ['**/*.ts'], path: '.hidden/value.ts', input: false },
  {
    globs: ['.hidden/**/*.ts'],
    excludes: ['**/.hidden/**'],
    path: '.hidden/value.ts',
    input: false,
  },
])('decides input for $path with $globs excluding $excludes: $input', (fact) => {
  expect(rules(fact.globs, fact.excludes).isInput(fact.path)).toBe(fact.input);
});

it.each([
  { excludes: ['**/x'], name: 'src', path: 'src', enters: true },
  { excludes: ['src'], name: 'src', path: 'src', enters: false },
  { excludes: ['**/node_modules/**'], name: 'node_modules', path: 'a/node_modules', enters: false },
  { excludes: [], name: '.git', path: '.git', enters: false },
  { excludes: [], name: '.pi', path: '.pi', enters: true },
])('decides entering $path with excludes $excludes: $enters', (fact) => {
  const walk = rules(['.pi/tau.json', '**/*.ts'], fact.excludes);

  expect(walk.entersDirectory(fact.name, fact.path)).toBe(fact.enters);
});

it.each([
  { realPath: '/repo/a', ancestors: ['/repo'], loop: false },
  { realPath: '/repo', ancestors: ['/repo', '/repo/a'], loop: true },
  { realPath: '/repo/a', ancestors: ['/repo', '/repo/a'], loop: true },
  { realPath: '/repo/ab', ancestors: ['/repo', '/repo/a'], loop: false },
  { realPath: '/elsewhere', ancestors: ['/repo'], loop: false },
])('decides loop for $realPath under $ancestors: $loop', (fact) => {
  expect(closesLoop(fact.realPath, new Set(fact.ancestors))).toBe(fact.loop);
});
