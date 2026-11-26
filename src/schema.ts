import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { TSchema, TUnsafe } from 'typebox';
import { Value } from 'typebox/value';

// A key set to `true` is a known leaf. A nested object lists the known keys below it. The key `*`
// describes every key not listed, for objects that map free names to entries. The key `[]`
// describes each item of an array value at that node.
export interface KnownKeys {
  readonly [key: string]: KnownKeys | true;
}

export type AskKind = 'choice' | 'approval';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const newerRecordVersion = (
  value: unknown,
  supportedVersion: number,
): number | undefined => {
  const claimed = isRecord(value) ? value['version'] : undefined;

  return typeof claimed === 'number' && claimed > supportedVersion ? claimed : undefined;
};

export const describeSchemaProblem = (schema: TSchema, value: unknown): string => {
  const [error] = Value.Errors(schema, value);

  return error === undefined ? 'unknown problem' : `${error.instancePath || '/'} ${error.message}`;
};

// Adds additionalProperties: false to every object schema, so Pi refuses an argument the tool does
// not declare. A map schema keeps its additionalProperties schema, which constrains every key.
// Every keyword that holds a subschema must appear in one of these sets, or a tool can ship an open
// schema under it.
export const schemaMapKeywords = new Set([
  '$defs',
  'definitions',
  'dependencies',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

export const schemaArrayKeywords = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

export const schemaValueKeywords = new Set([
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
]);

const strictSchemaMap = (value: unknown, visit: (child: unknown) => unknown): unknown => {
  if (!isRecord(value)) {
    return value;
  }

  const clone: Record<PropertyKey, unknown> = { ...value };

  for (const key of Object.keys(value)) {
    clone[key] = visit(value[key]);
  }

  return clone;
};

const strictSchemaValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(strictSchemaValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  const clone: Record<PropertyKey, unknown> = { ...value };

  for (const key of Object.keys(value)) {
    const child = value[key];

    if (schemaMapKeywords.has(key)) {
      clone[key] = strictSchemaMap(child, strictSchemaValue);
    } else if (schemaArrayKeywords.has(key)) {
      clone[key] = Array.isArray(child) ? child.map(strictSchemaValue) : child;
    } else if (schemaValueKeywords.has(key)) {
      clone[key] = strictSchemaValue(child);
    }
  }

  if (value['type'] === 'object') {
    const additionalProperties = value['additionalProperties'];

    if (additionalProperties === undefined || additionalProperties === true) {
      clone['additionalProperties'] = false;
    }
  }

  return clone;
};

export const strictToolParameters = <Schema extends TSchema>(schema: Schema): Schema => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the clone keeps every schema field and only adds additionalProperties to object nodes.
  return strictSchemaValue(schema) as Schema;
};

const installedApis = new WeakSet<ExtensionAPI>();

// Wraps `registerTool` once per API. Every tool registered through that API after this call has
// strict parameters, including tools that another extension registers.
export const strictToolRegistration = (pi: ExtensionAPI): void => {
  if (installedApis.has(pi)) {
    return;
  }

  installedApis.add(pi);

  const registerTool = pi.registerTool.bind(pi);

  pi.registerTool = (tool) => {
    // oxlint-disable-next-line typescript/no-confusing-void-expression -- the installed API may return a value at runtime, and the wrapper must keep it.
    return registerTool({ ...tool, parameters: strictToolParameters(tool.parameters) });
  };
};

export const stringEnum = <const Values extends readonly string[]>(
  values: Values,
  options: { description?: string } = {},
): TUnsafe<Values[number]> =>
  Type.Unsafe<Values[number]>({ ...options, type: 'string', enum: [...values] });

export const anyKey = '*';

export const anyItem = '[]';

export const findUnknownKeys = (value: unknown, known: KnownKeys, path: string): string[] => {
  if (Array.isArray(value)) {
    const itemKeys = known[anyItem];

    if (itemKeys === undefined || itemKeys === true) {
      return [];
    }

    return value.flatMap((item, index) => findUnknownKeys(item, itemKeys, `${path}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const keyPath = path === '' ? key : `${path}.${key}`;
    const expected = Object.hasOwn(known, key) ? known[key] : known[anyKey];

    if (expected === undefined) {
      return [keyPath];
    }

    return expected === true ? [] : findUnknownKeys(child, expected, keyPath);
  });
};

export const reportedId = (file: string, path: string): string => `${file}\n${path}`;

// The key paths of `file` that were not reported before. Reported keys are `file` and path pairs.
export const unreportedKeys = (
  reported: ReadonlySet<string>,
  file: string,
  paths: readonly string[],
): string[] => [...new Set(paths)].filter((path) => !reported.has(reportedId(file, path)));
