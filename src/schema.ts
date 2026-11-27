import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { TSchema, TUnsafe } from 'typebox';
import { Value } from 'typebox/value';

// A key set to `true` is a known leaf. A nested object lists the known keys below it. The key `*`
// describes every key not listed, for objects that map free names to entries. The key `[]`
// describes each item of an array value at that node.
export interface KnownKeys {
  readonly [key: string]: KnownKeys | true;
}

// A registration call whose declared signature returns void, viewed so the wrapper can keep the
// value an installed function returns at runtime.
type RegisterToolReturningValue = <ToolSchema extends TSchema, ToolDetails = unknown>(
  tool: ToolDefinition<ToolSchema, ToolDetails>,
) => unknown;

// The API shape read at installation. `registerTool` may be absent, an accessor, or a proxy trap.
interface RegisterToolHost {
  registerTool?: RegisterToolReturningValue | undefined;
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

// Adds additionalProperties: false to every object schema in an asserted position, so Pi refuses an
// argument the tool does not declare. A map schema keeps its additionalProperties schema, which
// constrains every key. A node counts as an object when its type includes `object`, or when it
// declares `properties` or `patternProperties` without a type. A subschema under `not` or `if`
// narrows the negation or condition instead, so closing anything inside it would accept inputs the
// tool rejects. A subschema under `then`, `else`, or `allOf` combines with sibling schemas, so
// closing anything below it could reject an argument the tool declares; the whole subtree stays as
// written. The schema form of `dependencies` and `dependentSchemas` applies to the whole instance
// when a named property is present, like a conditional `allOf`, so they stay as written too. Add a
// keyword to one of these sets when a tool schema can hold a subschema under it. A subschema under
// a keyword outside these sets stays as written, so an object there keeps its keys open, including
// objects nested inside it. An explicit additionalProperties: true stays, because the tool author
// declared free-form input; closing it would reject calls the author declared valid.
export const schemaMapKeywords: ReadonlySet<string> = new Set([
  '$defs',
  'definitions',
  'patternProperties',
  'properties',
]);

export const schemaArrayKeywords: ReadonlySet<string> = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);

export const schemaValueKeywords: ReadonlySet<string> = new Set([
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

// A subschema under one of these keywords narrows the instance instead of asserting it, or combines
// with sibling schemas. Closing any object below one of them could accept an input the negation or
// condition rejects, or reject a value a sibling declares, so the whole subtree stays as written.
// The schema form of `dependencies` and `dependentSchemas` combines with the whole instance, so its
// subschemas stay open as well.
export const schemaUnassertedKeywords: ReadonlySet<string> = new Set([
  'allOf',
  'dependencies',
  'dependentSchemas',
  'else',
  'if',
  'not',
  'then',
]);

const declaresObject = (value: Record<string, unknown>): boolean => {
  const type = value['type'];

  if (type === 'object') {
    return true;
  }

  if (Array.isArray(type) && type.includes('object')) {
    return true;
  }

  const declaresKeys = 'properties' in value || 'patternProperties' in value;

  return type === undefined && declaresKeys;
};

const strictSchemaMap = (
  value: unknown,
  asserted: boolean,
  visit: (child: unknown, asserted: boolean) => unknown,
): unknown => {
  if (!isRecord(value)) {
    return value;
  }

  const clone: Record<PropertyKey, unknown> = { ...value };

  for (const key of Object.keys(value)) {
    clone[key] = visit(value[key], asserted);
  }

  return clone;
};

const strictSchemaChild = (
  key: string,
  child: unknown,
  asserted: boolean,
  visit: (value: unknown, asserted: boolean) => unknown,
): unknown => {
  if (schemaUnassertedKeywords.has(key)) {
    return visit(child, false);
  }

  if (schemaMapKeywords.has(key)) {
    return strictSchemaMap(child, asserted, visit);
  }

  if (schemaArrayKeywords.has(key)) {
    return Array.isArray(child) ? child.map((entry) => visit(entry, asserted)) : child;
  }

  if (schemaValueKeywords.has(key)) {
    return visit(child, asserted);
  }

  return child;
};

const strictSchemaValue = (value: unknown, asserted = true): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => strictSchemaValue(item, asserted));
  }

  if (!isRecord(value)) {
    return value;
  }

  const clone: Record<PropertyKey, unknown> = { ...value };

  for (const key of Object.keys(value)) {
    clone[key] = strictSchemaChild(key, value[key], asserted, strictSchemaValue);
  }

  if (asserted && declaresObject(value)) {
    const additionalProperties = value['additionalProperties'];

    if (additionalProperties === undefined) {
      clone['additionalProperties'] = false;
    }
  }

  return clone;
};

export const strictToolParameters = <Schema extends TSchema>(schema: Schema): Schema => {
  const strict = strictSchemaValue(schema);

  return isRecord(strict) ? { ...schema, ...strict } : schema;
};

const installedApis = new WeakSet<ExtensionAPI>();

const notWritableMessage =
  'Cannot install strict tool parameters: registerTool is not writable on this API.';

const notReadableMessage =
  'Cannot install strict tool parameters: registerTool is not readable on this API.';

const installWrapper = (pi: ExtensionAPI): ExtensionAPI['registerTool'] => {
  const host: RegisterToolHost = pi;
  let current: RegisterToolReturningValue | undefined;

  // An accessor or proxy trap may throw or return a different function on each read, so read the
  // property once and bind the value that was checked.
  try {
    current = host.registerTool;
  } catch (error) {
    throw new Error(notReadableMessage, { cause: error });
  }

  if (typeof current !== 'function') {
    throw new TypeError('Cannot install strict tool parameters: registerTool is not a function.');
  }

  const registered = current.bind(pi);

  const wrapper: RegisterToolReturningValue = (tool) => {
    const registeredTool = registered({
      ...tool,
      parameters: strictToolParameters(tool.parameters),
    });

    return registeredTool;
  };

  try {
    pi.registerTool = wrapper;
  } catch (error) {
    throw new Error(notWritableMessage, { cause: error });
  }

  const descriptor = Object.getOwnPropertyDescriptor(pi, 'registerTool');
  const installed: unknown = descriptor?.value;
  let readBack: unknown;

  try {
    readBack = descriptor?.get?.call(pi);
  } catch (error) {
    throw new Error(notReadableMessage, { cause: error });
  }

  if (installed !== wrapper && readBack !== wrapper) {
    throw new Error(notWritableMessage);
  }

  return wrapper;
};

// Wraps `registerTool` once per API. Every tool registered through that API after this call has
// strict parameters, including tools that another extension registers.
export const strictToolRegistration = (pi: ExtensionAPI): void => {
  if (installedApis.has(pi)) {
    return;
  }

  installWrapper(pi);
  installedApis.add(pi);
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
