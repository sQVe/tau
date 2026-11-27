import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import {
  isRecord,
  schemaArrayKeywords,
  schemaMapKeywords,
  schemaUnassertedKeywords,
  schemaValueKeywords,
  strictToolParameters,
} from './schema.js';

// `unicorn/no-thenable` reads a literal `then` key as a promise method, so spell the JSON Schema
// keyword from parts.
const thenKeyword = ['the', 'n'].join('');

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

it('keeps an explicit additionalProperties: true because the author declared free-form input', () => {
  const schema = Type.Unsafe<unknown>({
    type: 'object',
    properties: { value: { type: 'string' } },
    additionalProperties: true,
  });

  const strict = strictToolParameters(schema);

  expect(strict).toMatchObject({ additionalProperties: true });
  expect(Value.Check(strict, { value: 'a', extra: 1 })).toBe(true);
});

it.each([
  {
    name: 'dependentSchemas',
    keyword: 'dependentSchemas',
    dependent: {
      properties: { billing_address: { type: 'string' } },
      required: ['billing_address'],
    },
  },
  {
    name: 'the schema form of dependencies',
    keyword: 'dependencies',
    dependent: {
      properties: { billing_address: { type: 'string' } },
      required: ['billing_address'],
    },
  },
])(
  'keeps a subschema under $name open to the properties the enclosing schema declares',
  ({ keyword, dependent }) => {
    const schema = {
      type: 'object',
      properties: { credit_card: { type: 'string' }, billing_address: { type: 'string' } },
      [keyword]: { credit_card: dependent },
    };

    const strict = strictToolParameters(Type.Unsafe<unknown>(schema));
    const dependentSchemas = isRecord(strict) ? strict[keyword] : undefined;

    const dependentSubschema = isRecord(dependentSchemas)
      ? dependentSchemas['credit_card']
      : undefined;

    expect(dependentSubschema).not.toHaveProperty('additionalProperties');
    expect(Value.Check(strict, { credit_card: 'x', billing_address: 'y' })).toBe(true);
  },
);

it('keeps a node that carries only the schema form of dependencies open', () => {
  const schema = {
    type: 'object',
    properties: { credit_card: { type: 'string' } },
    dependencies: { credit_card: { required: ['billing_address'] } },
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { credit_card: 'x', billing_address: 'y' })).toBe(true);
});

it('leaves an object nested under a dependent schema open', () => {
  const schema = {
    type: 'object',
    properties: { credit_card: { type: 'string' }, address: {} },
    dependentSchemas: {
      credit_card: {
        properties: {
          address: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    },
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { credit_card: 'x', address: { city: 'a', extra: 1 } })).toBe(true);
  expect(Value.Check(strict, { credit_card: 'x', address: { city: 1 } })).toBe(false);
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

it('leaves an object schema under contains, then, or else open', () => {
  const schema: Record<string, unknown> = {
    type: 'object',
    [thenKeyword]: childSchema(),
    else: childSchema(),
    contains: childSchema(),
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));
  const thenChild = isRecord(strict) ? strict['then'] : undefined;
  const elseChild = isRecord(strict) ? strict['else'] : undefined;
  const containsChild = isRecord(strict) ? strict['contains'] : undefined;

  expect(thenChild).toEqual(childSchema());
  expect(elseChild).toEqual(childSchema());
  expect(containsChild).toEqual(childSchema());
});

it('keeps a then, else, or allOf subschema from rejecting a declared argument', () => {
  const schema = {
    type: 'object',
    properties: { mode: { type: 'string' }, detail: { type: 'string' } },
    if: { properties: { mode: { const: 'a' } } },
    [thenKeyword]: { type: 'object', properties: { mode: { type: 'string' } } },
    else: { type: 'object', properties: { detail: { type: 'string' } } },
    allOf: [{ type: 'object', properties: { detail: { type: 'string' } } }],
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { mode: 'a', detail: 'b' })).toBe(true);
  expect(Value.Check(strict, { mode: 'b', detail: 'b' })).toBe(true);
  // A node that combines with a sibling stays open, because the sibling may declare a name it
  // does not list itself.
  expect(Value.Check(strict, { mode: 'a', detail: 'b', extra: 1 })).toBe(true);
});

it('keeps a property that only a combining branch declares', () => {
  const schema = {
    type: 'object',
    properties: { mode: { type: 'string' } },
    allOf: [{ properties: { detail: { type: 'string' } } }],
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { mode: 'a', detail: 'b' })).toBe(true);
  expect(Value.Check(strict, { mode: 'a', detail: 1 })).toBe(false);
});

it.each(['anyOf', 'oneOf'])('keeps a property that only a %s branch declares', (keyword) => {
  const schema = {
    type: 'object',
    properties: { mode: { type: 'string' } },
    [keyword]: [{ properties: { detail: { type: 'string' } } }],
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { mode: 'a', detail: 'b' })).toBe(true);
  expect(Value.Check(strict, { mode: 'a', detail: 1 })).toBe(false);
});

it('keeps an object referenced by a sibling $ref from closing itself', () => {
  const schema = {
    type: 'object',
    $ref: '#/$defs/x',
    $defs: { x: { type: 'object', properties: { mode: { type: 'string' } } } },
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { mode: 'a', extra: 1 })).toBe(true);
});

it('leaves a definition as written because an unasserted position may reference it', () => {
  const schema = {
    type: 'object',
    properties: { detail: { $ref: '#/$defs/x' } },
    if: { $ref: '#/$defs/x' },
    $defs: { x: { type: 'object', properties: { secret: { type: 'string' } } } },
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { detail: { secret: 'a', extra: 1 } })).toBe(true);
});

it('keeps an item that a sibling items schema declares matching contains', () => {
  const schema = {
    type: 'array',
    items: { type: 'object', properties: { a: {}, b: {} } },
    contains: { type: 'object', properties: { a: {} }, required: ['a'] },
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, [{ a: 1, b: 2 }])).toBe(true);
});

it('does not rewrite an object value under const or enum', () => {
  const embeddedConstant = { type: 'object', properties: {} };

  const constant = strictToolParameters(
    Type.Unsafe<unknown>({ type: 'object', const: embeddedConstant }),
  );

  const enumerated = strictToolParameters(
    Type.Unsafe<unknown>({ type: 'object', enum: [embeddedConstant] }),
  );

  const storedConstant = isRecord(constant) ? constant['const'] : undefined;
  const storedEnum = isRecord(enumerated) ? enumerated['enum'] : undefined;

  expect(storedConstant).toEqual(embeddedConstant);
  expect(storedEnum).toEqual([embeddedConstant]);
  expect(Value.Check(constant, embeddedConstant)).toBe(true);
  expect(Value.Check(enumerated, embeddedConstant)).toBe(true);
});

it('keeps an object nested under an allOf branch open', () => {
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

  expect(Value.Check(strict, { detail: { note: 'a', extra: 1 } })).toBe(true);
});

it.each([
  { name: 'then', branch: 'then', mode: 'a' },
  { name: 'else', branch: 'else', mode: 'b' },
])('keeps an object nested under a $name branch open', ({ branch, mode }) => {
  const schema = {
    type: 'object',
    properties: { mode: { type: 'string' }, detail: {} },
    if: { properties: { mode: { const: 'a' } } },
    [branch]: {
      properties: { detail: { type: 'object', properties: { note: { type: 'string' } } } },
    },
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { mode, detail: { note: 'a', extra: 1 } })).toBe(true);
});

// The branch usually refines an object that the enclosing schema declares more fully. Both
// subschemas combine, so closing the branch's copy would reject the properties only the enclosing
// schema declares.
it('keeps the nested object of a branch open to the properties the enclosing schema declares', () => {
  const schema = {
    type: 'object',
    properties: {
      detail: {
        type: 'object',
        properties: { note: { type: 'string' }, other: { type: 'string' } },
      },
    },
    allOf: [
      { properties: { detail: { type: 'object', properties: { note: { type: 'string' } } } } },
    ],
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { detail: { note: 'a', other: 'b' } })).toBe(true);
  expect(Value.Check(strict, { detail: { note: 'a', extra: 'b' } })).toBe(false);
});

it.each([
  { name: 'then', branch: 'then', mode: 'a' },
  { name: 'else', branch: 'else', mode: 'b' },
])('keeps a $name branch nested object open to the enclosing properties', ({ branch, mode }) => {
  const schema = {
    type: 'object',
    properties: {
      mode: { type: 'string' },
      detail: {
        type: 'object',
        properties: { note: { type: 'string' }, other: { type: 'string' } },
      },
    },
    if: { properties: { mode: { const: 'a' } } },
    [branch]: {
      properties: { detail: { type: 'object', properties: { note: { type: 'string' } } } },
    },
  };

  const strict = strictToolParameters(Type.Unsafe<unknown>(schema));

  expect(Value.Check(strict, { mode, detail: { note: 'a', other: 'b' } })).toBe(true);
  expect(Value.Check(strict, { mode, detail: { note: 'a', extra: 'b' } })).toBe(false);
});

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

const expectedSchemaMapKeywords = ['patternProperties', 'properties'];

const expectedSchemaArrayKeywords = ['prefixItems'];

const expectedSchemaValueKeywords = [
  'additionalItems',
  'additionalProperties',
  'items',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
];

// Pins the sets so a change to them is a deliberate edit. It does not claim the list is complete.
it('pins the subschema keyword sets', () => {
  expect([...schemaMapKeywords].toSorted()).toEqual(expectedSchemaMapKeywords);
  expect([...schemaArrayKeywords].toSorted()).toEqual(expectedSchemaArrayKeywords);
  expect([...schemaValueKeywords].toSorted()).toEqual(expectedSchemaValueKeywords);

  expect([...schemaUnassertedKeywords].toSorted()).toEqual([
    'allOf',
    'anyOf',
    'contains',
    'dependencies',
    'dependentSchemas',
    'else',
    'if',
    'not',
    'oneOf',
    'then',
  ]);
});

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
    const child = isRecord(strict) ? strict[keyword] : undefined;

    if (!isClosed(child)) {
      unclosed.push(keyword);
    }
  }

  expect(unclosed).toEqual([]);
});

it('does not rewrite an object value stored in default or examples', () => {
  const schema = Type.Object(
    { value: Type.String() },
    { default: { type: 'object' }, examples: [{ type: 'object' }] },
  );

  expect(strictToolParameters(schema)).toEqual(
    expect.objectContaining({
      default: { type: 'object' },
      examples: [{ type: 'object' }],
      additionalProperties: false,
    }),
  );
});
