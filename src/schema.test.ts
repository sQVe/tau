import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
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
  strictToolRegistration,
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

const isClosed = (value: unknown): boolean =>
  isRecord(value) && value['additionalProperties'] === false;

const childSchema = (): Record<string, unknown> => ({
  type: 'object',
  properties: { value: { type: 'string' } },
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

it('closes an object schema whose type list includes object', () => {
  const schema = { type: ['object', 'null'], properties: { value: { type: 'string' } } };

  expect(strictToolParameters(Type.Unsafe<unknown>(schema))).toMatchObject({
    additionalProperties: false,
  });
});

it('closes an object schema that declares properties without a type', () => {
  const schema = { properties: { value: { type: 'string' } } };

  expect(strictToolParameters(Type.Unsafe<unknown>(schema))).toMatchObject({
    additionalProperties: false,
  });
});

it('closes an object schema that declares patternProperties without a type', () => {
  const schema = { patternProperties: { '^[a-z]+$': { type: 'string' } } };

  expect(strictToolParameters(Type.Unsafe<unknown>(schema))).toMatchObject({
    additionalProperties: false,
  });
});

it('closes an object schema under contains but not under then or else', () => {
  const schema: Record<string, unknown> = {
    type: 'object',
    // oxlint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema keyword, not a promise method.
    then: childSchema(),
    else: childSchema(),
    contains: childSchema(),
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));
  const thenChild = isRecord(strict) ? strict['then'] : undefined;
  const elseChild = isRecord(strict) ? strict['else'] : undefined;
  const containsChild = isRecord(strict) ? strict['contains'] : undefined;

  expect(thenChild).toEqual(childSchema());
  expect(elseChild).toEqual(childSchema());
  expect(containsChild).toMatchObject({ additionalProperties: false });
});

it('keeps a then, else, or allOf subschema from rejecting a declared argument', () => {
  const schema = {
    type: 'object',
    properties: { mode: { type: 'string' }, detail: { type: 'string' } },
    if: { properties: { mode: { const: 'a' } } },
    // oxlint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema keyword, not a promise method.
    then: { type: 'object', properties: { mode: { type: 'string' } } },
    else: { type: 'object', properties: { detail: { type: 'string' } } },
    allOf: [{ type: 'object', properties: { detail: { type: 'string' } } }],
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { mode: 'a', detail: 'b' })).toBe(true);
  expect(Value.Check(strict, { mode: 'b', detail: 'b' })).toBe(true);
  expect(Value.Check(strict, { mode: 'a', detail: 'b', extra: 1 })).toBe(false);
});

it('closes an object nested under an allOf branch while the branch stays open', () => {
  const schema = {
    type: 'object',
    properties: { detail: {} },
    allOf: [
      {
        properties: { detail: { type: 'object', properties: { note: { type: 'string' } } } },
      },
    ],
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { detail: { note: 'a' } })).toBe(true);
  expect(Value.Check(strict, { detail: { note: 'a', extra: 1 } })).toBe(false);
});

it.each([
  { name: 'then', branch: 'then', mode: 'a' },
  { name: 'else', branch: 'else', mode: 'b' },
])(
  'closes an object nested under a $name branch while the branch stays open',
  ({ branch, mode }) => {
    const schema = {
      type: 'object',
      properties: { mode: { type: 'string' }, detail: {} },
      if: { properties: { mode: { const: 'a' } } },
      [branch]: {
        properties: { detail: { type: 'object', properties: { note: { type: 'string' } } } },
      },
    };

    const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

    expect(Value.Check(strict, { mode, detail: { note: 'a' } })).toBe(true);
    expect(Value.Check(strict, { mode, detail: { note: 'a', extra: 1 } })).toBe(false);
  },
);

it('leaves an object schema under not and if open', () => {
  const schema = { type: 'object', not: childSchema(), if: childSchema() };
  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));
  const notChild = isRecord(strict) ? strict['not'] : undefined;
  const ifChild = isRecord(strict) ? strict['if'] : undefined;

  expect(strict).toMatchObject({ additionalProperties: false });
  expect(notChild).toEqual(childSchema());
  expect(ifChild).toEqual(childSchema());
});

it('leaves a nested object under not open', () => {
  const schema = {
    type: 'object',
    not: { type: 'object', properties: { nested: { type: 'object', properties: {} } } },
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));
  const notChild = isRecord(strict) ? strict['not'] : undefined;

  expect(notChild).toEqual({
    type: 'object',
    properties: { nested: { type: 'object', properties: {} } },
  });
});

const registrationApi = (registerTool: (tool: unknown) => unknown): ExtensionAPI =>
  ({ registerTool }) as unknown as ExtensionAPI;

const registerThrough = (api: ExtensionAPI, parameters: TSchema): unknown => {
  const register = api.registerTool as unknown as (tool: unknown) => unknown;

  return register({ name: 'sample', parameters });
};

it('closes the parameters of a tool registered through the wrapped API', () => {
  const registered: unknown[] = [];
  const api = registrationApi((tool) => registered.push(tool));

  strictToolRegistration(api);
  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(registered).toMatchObject([
    {
      name: 'sample',
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);
});

it('installs the wrapper once per API', () => {
  const registered: unknown[] = [];
  const api = registrationApi((tool) => registered.push(tool));

  strictToolRegistration(api);
  const wrapper = api.registerTool;

  strictToolRegistration(api);

  registerThrough(api, Type.Object({}));

  expect(api.registerTool).toBe(wrapper);
  expect(registered).toHaveLength(1);
});

it('installs through an API that intercepts reads of registerTool', () => {
  const registered: unknown[] = [];
  const target = registrationApi((tool) => registered.push(tool));

  const api = new Proxy(target, {
    get: (value, key) => {
      const properties = value as unknown as Record<PropertyKey, unknown>;
      const property = properties[key];

      if (key !== 'registerTool' || typeof property !== 'function') {
        return property;
      }

      const registerTool = property as (tool: unknown) => unknown;

      return (tool: unknown) => registerTool(tool);
    },
  });

  strictToolRegistration(api);
  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(registered).toMatchObject([
    {
      name: 'sample',
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);
});

it('keeps the value the wrapped registration returns', () => {
  const api = registrationApi(() => 'registered');

  strictToolRegistration(api);

  expect(registerThrough(api, Type.Object({}))).toBe('registered');
});

it('reports a clear error when registerTool is not a function', () => {
  const api = {} as unknown as ExtensionAPI;

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not a function.');
});

it('reports a clear error when registerTool cannot be replaced', () => {
  const api = registrationApi(() => undefined);

  Object.defineProperty(api, 'registerTool', { configurable: false, writable: false });

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not writable on this API.');
});

it('reports a clear error when registerTool ignores the replacement', () => {
  const api = new Proxy(
    registrationApi(() => undefined),
    { set: () => true },
  );

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not writable on this API.');
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

// Pins the sets so a change to them is a deliberate edit. It does not claim the list is complete.
it('pins the subschema keyword sets', () => {
  expect([...schemaMapKeywords].toSorted()).toEqual(expectedSchemaMapKeywords);
  expect([...schemaArrayKeywords].toSorted()).toEqual(expectedSchemaArrayKeywords);
  expect([...schemaValueKeywords].toSorted()).toEqual(expectedSchemaValueKeywords);
});

// A schema under `not` or `if` narrows the negation or condition instead, so closing it would
// accept inputs the tool rejects. A `then` or `else` branch lists only the conditioned properties,
// so closing it would reject the others.
const unassertedKeywords = new Set(['else', 'if', 'not', 'then']);

// An `allOf` branch combines with its siblings, so closing it would require that one branch to
// declare every property.
const unassertedArrayKeywords = new Set(['allOf']);

it('closes an object schema under every asserted subschema keyword in the sets', () => {
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
  const loosened: string[] = [];

  for (const keyword of schemaMapKeywords) {
    const entries = isRecord(strict) ? strict[keyword] : undefined;

    if (!isRecord(entries) || !isClosed(entries['child'])) {
      unclosed.push(keyword);
    }
  }

  for (const keyword of schemaArrayKeywords) {
    const entries = isRecord(strict) ? strict[keyword] : undefined;

    if (!Array.isArray(entries)) {
      unclosed.push(keyword);
    } else if (unassertedArrayKeywords.has(keyword)) {
      if (entries.some((entry) => isClosed(entry))) {
        loosened.push(keyword);
      }
    } else if (!entries.every((entry) => isClosed(entry))) {
      unclosed.push(keyword);
    }
  }

  for (const keyword of schemaValueKeywords) {
    const child = isRecord(strict) ? strict[keyword] : undefined;

    if (unassertedKeywords.has(keyword) && isClosed(child)) {
      loosened.push(keyword);
    } else if (!unassertedKeywords.has(keyword) && !isClosed(child)) {
      unclosed.push(keyword);
    }
  }

  expect({ unclosed, loosened }).toEqual({ unclosed: [], loosened: [] });
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
