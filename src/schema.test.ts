import { expect, it } from 'vitest';

import { anyKey, findUnknownKeys, reportedId, unreportedKeys } from './schema.js';
import type { KnownKeys } from './schema.js';

const known: KnownKeys = {
  model: true,
  routes: { question: true, labels: { [anyKey]: { criterion: true, model: true } } },
};

it.for<[string, unknown, string[]]>([
  ['known keys', { model: 'a/b', routes: { question: 'q' } }, []],
  ['a top-level key', { model: 'a/b', futureKey: 1 }, ['profiles.worker.futureKey']],
  [
    'nested keys under a wildcard',
    { routes: { extra: 1, labels: { wide: { criterion: 'c', speed: 2 } } } },
    ['profiles.worker.routes.extra', 'profiles.worker.routes.labels.wide.speed'],
  ],
  [
    'names that Object.prototype also has',
    { model: 'a/b', constructor: 1, toString: 2 },
    ['profiles.worker.constructor', 'profiles.worker.toString'],
  ],
  ['a value that is not an object', 'text', []],
  ['a known key with a wrong type', { routes: 5 }, []],
  ['a known leaf key that holds an object', { model: { name: 'a/b' } }, []],
])('finds unknown keys for %s', ([, value, expected]) => {
  expect(findUnknownKeys(value, known, 'profiles.worker')).toEqual(expected);
});

it('names a key at the root of the file without a leading dot', () => {
  expect(findUnknownKeys({ model: 'a/b', modle: 'a/b' }, known, '')).toEqual(['modle']);
});

it('drops key paths already reported for the same file and repeats them for another file', () => {
  const reported = new Set([reportedId('/user.json', 'a.b')]);

  expect(unreportedKeys(reported, '/user.json', ['a.b', 'a.c', 'a.c'])).toEqual(['a.c']);
  expect(unreportedKeys(reported, '/other.json', ['a.b'])).toEqual(['a.b']);
});
