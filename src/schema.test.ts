import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import {
  anyItem,
  anyKey,
  findUnknownKeys,
  isRecord,
  newerRecordVersion,
  reportedId,
  schemaArrayKeywords,
  schemaMapKeywords,
  schemaValueKeywords,
  strictToolParameters,
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

it('closes a nested object schema', () => {
  const schema = Type.Object({
    nested: Type.Object({ value: Type.String() }),
  });

  expect(strictToolParameters(schema)).toMatchObject({
    additionalProperties: false,
    properties: {
      nested: {
        additionalProperties: false,
        properties: { value: { type: 'string' } },
      },
    },
  });
});

it('keeps a schema-valued additionalProperties on a map schema', () => {
  const schema = Type.Object({
    values: Type.Object({}, { additionalProperties: Type.String() }),
  });

  expect(strictToolParameters(schema)).toMatchObject({
    properties: {
      values: {
        additionalProperties: { type: 'string' },
      },
    },
  });
});

it('leaves an existing false additionalProperties alone', () => {
  const schema = Type.Object({ value: Type.String() }, { additionalProperties: false });

  expect(strictToolParameters(schema)).toMatchObject({ additionalProperties: false });
});

const expectedSchemaMapKeywords = [
  '$defs',
  'definitions',
  'dependencies',
  'dependentSchemas',
  'patternProperties',
  'properties',
];

const expectedSchemaArrayKeywords = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

const expectedSchemaValueKeywords = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];

it('lists every subschema keyword in the production sets', () => {
  expect([...schemaMapKeywords].toSorted()).toEqual(expectedSchemaMapKeywords);
  expect([...schemaArrayKeywords].toSorted()).toEqual(expectedSchemaArrayKeywords);
  expect([...schemaValueKeywords].toSorted()).toEqual(expectedSchemaValueKeywords);
});

const isClosed = (value: unknown): boolean =>
  isRecord(value) && value['additionalProperties'] === false;

const childSchema = (): Record<string, unknown> => ({
  type: 'object',
  properties: { value: { type: 'string' } },
});

it('closes an object schema under every subschema keyword in the sets', () => {
  const schema: Record<string, unknown> = { type: 'object' };

  for (const keyword of schemaMapKeywords) {
    schema[keyword] = { child: childSchema() };
  }

  for (const keyword of schemaArrayKeywords) {
    schema[keyword] = [childSchema()];
  }

  for (const keyword of schemaValueKeywords) {
    schema[keyword] = childSchema();
  }

  const strict: unknown = strictToolParameters(Type.Unsafe<unknown>(schema));
  const unclosed: string[] = [];

  for (const keyword of schemaMapKeywords) {
    const entries = isRecord(strict) ? strict[keyword] : undefined;

    if (!isRecord(entries) || !isClosed(entries['child'])) {
      unclosed.push(keyword);
    }
  }

  for (const keyword of schemaArrayKeywords) {
    const entries = isRecord(strict) ? strict[keyword] : undefined;

    if (!Array.isArray(entries) || !entries.every((entry) => isClosed(entry))) {
      unclosed.push(keyword);
    }
  }

  for (const keyword of schemaValueKeywords) {
    if (!isRecord(strict) || !isClosed(strict[keyword])) {
      unclosed.push(keyword);
    }
  }

  expect(unclosed).toEqual([]);
});

it('does not rewrite an object value stored in an annotation keyword', () => {
  const schema = Type.Object(
    { value: Type.String() },
    { default: { type: 'object' }, examples: [{ type: 'object' }], const: { type: 'object' } },
  );

  expect(strictToolParameters(schema)).toEqual(
    expect.objectContaining({
      default: { type: 'object' },
      examples: [{ type: 'object' }],
      const: { type: 'object' },
    }),
  );
});
