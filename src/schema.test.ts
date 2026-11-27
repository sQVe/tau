import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import {
  anyItem,
  anyKey,
  findUnknownKeys,
  newerRecordVersion,
  reportedId,
  stringEnum,
  unreportedKeys,
} from './schema.js';
import type { KnownKeys } from './schema.js';

const known: KnownKeys = {
  model: true,
  routes: { question: true, labels: { [anyKey]: { criterion: true, model: true } } },
};

const items = { items: [{ name: 'a', extra: 1 }, 'text'] };

it.for<[string, unknown, KnownKeys, string[]]>([
  ['known keys', { model: 'a/b', routes: { question: 'q' } }, known, []],
  ['a top-level key', { model: 'a/b', futureKey: 1 }, known, ['profiles.worker.futureKey']],
  [
    'nested keys under a wildcard',
    { routes: { extra: 1, labels: { wide: { criterion: 'c', speed: 2 } } } },
    known,
    ['profiles.worker.routes.extra', 'profiles.worker.routes.labels.wide.speed'],
  ],
  [
    'names that Object.prototype also has',
    { model: 'a/b', constructor: 1, toString: 2 },
    known,
    ['profiles.worker.constructor', 'profiles.worker.toString'],
  ],
  [
    'keys inside array items with an item node',
    items,
    { items: { [anyItem]: { name: true } } },
    ['profiles.worker.items[0].extra'],
  ],
  ['keys inside array items without an item node', items, { items: { name: true } }, []],
  [
    'an item node declared as a leaf stops the walk',
    { items: [{ name: 'a', extra: 1 }] },
    { items: { [anyItem]: true } },
    [],
  ],
  ['a value that is not an object', 'text', known, []],
  ['a known key with a wrong type', { routes: 5 }, known, []],
  ['a known leaf key that holds an object', { model: { name: 'a/b' } }, known, []],
])('finds unknown keys for %s', ([, value, knownKeys, expected]) => {
  expect(findUnknownKeys(value, knownKeys, 'profiles.worker')).toEqual(expected);
});

it('names a key at the root of the file without a leading dot', () => {
  expect(findUnknownKeys({ model: 'a/b', modle: 'a/b' }, known, '')).toEqual(['modle']);
});

it('drops key paths already reported for the same file and repeats them for another file', () => {
  const reported = new Set([reportedId('/user.json', 'a.b')]);

  expect(unreportedKeys(reported, '/user.json', ['a.b', 'a.c', 'a.c'])).toEqual(['a.c']);
  expect(unreportedKeys(reported, '/other.json', ['a.b'])).toEqual(['a.b']);
});

it.for<[string, unknown, number | undefined]>([
  ['a newer numeric version', { version: 3 }, 3],
  ['the supported version', { version: 2 }, undefined],
  ['an older numeric version', { version: 1 }, undefined],
  ['a non-numeric version', { version: '3' }, undefined],
  ['a missing version', { steps: [] }, undefined],
  ['a value that is not a record', 'version 3', undefined],
  ['an array', [{ version: 3 }], undefined],
])('reads the claimed newer version for %s', ([, value, expected]) => {
  expect(newerRecordVersion(value, 2)).toBe(expected);
});

it('sends a string enum to model providers as a string type with an enum list', () => {
  const schema = stringEnum(['low', 'high'], { description: 'Level.' });

  expect(schema).toEqual({
    description: 'Level.',
    type: 'string',
    enum: ['low', 'high'],
  });
});

it.for<[unknown, boolean]>([
  ['low', true],
  ['high', true],
  ['medium', false],
  [1, false],
])('accepts only the listed strings in a string enum: %j', ([value, valid]) => {
  expect(Value.Check(stringEnum(['low', 'high']), value)).toBe(valid);
});
