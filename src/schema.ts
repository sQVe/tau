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

// A schema built in code may point at itself. JSON Schema must serialize, so a self-reference is
// refused instead of cloned. A node that two positions share is cloned once per closure rule,
// because the asserted and unasserted positions close a node differently.
interface SchemaWalk {
  readonly assertedClones: WeakMap<object, unknown>;
  readonly unassertedClones: WeakMap<object, unknown>;
  readonly assertedMapClones: WeakMap<object, unknown>;
  readonly unassertedMapClones: WeakMap<object, unknown>;
  readonly visiting: WeakSet<object>;
  readonly visit: (value: unknown, asserted: boolean) => unknown;
}

// The same object can sit in a map position and in a schema position, which clone it differently,
// so each position keeps its own cache.
type CloneRole = 'map' | 'schema';

// The marker a probe tool carries, so the wrapper recognizes the probe of this install.
interface ProbeTool {
  readonly [probeMarker]: true;
}

// The reached flag lives beside the probe rather than on it, so a host that freezes the probe it
// receives cannot make the wrapper fail.
interface InstallProbe {
  readonly tool: ProbeTool;
  reached: boolean;
}

// A schema node the walk clones, either an object or an array.
type SchemaNode = Record<PropertyKey, unknown> | readonly unknown[];

// A host that reads the probe's fields before it delegates still reaches the wrapper. A host that
// validates the definition refuses the probe, because the probe has no parameter schema, so such a
// host cannot be confirmed and the install reports the refusal. The probe stays invalid so a
// readback that stores it without delegating cannot register it. Only the probe of this install is
// evidence: another install's probe is refused without being registered.
type ProbeOutcome = 'reached' | 'refused' | 'unconfirmed';

interface InstalledWrapper {
  wrapper: RegisterToolReturningValue;
  // Whether a read of registerTool returned the wrapper itself. An accessor or proxy host can return
  // a new function on every read, so a differing read does not prove the host replaced the wrapper.
  stable: boolean;
}

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
// tool rejects. A subschema under a combining keyword (`allOf`, `anyOf`, `oneOf`, `then`, `else`,
// `contains`, or a dependent schema) combines with sibling schemas, so closing anything below it
// could reject an argument the tool declares; the whole subtree stays as written. The schema form
// of `dependencies` and `dependentSchemas` applies to the whole instance when a named property is
// present, like a conditional `allOf`, so they stay as written too. A definition stays as written,
// because a `$ref` may reach it from an unasserted position. Add a keyword to one of these sets when
// a tool schema can hold a subschema under it. A subschema under a keyword outside these sets stays
// as written, so an object there keeps its keys open, including objects nested inside it. An
// explicit additionalProperties: true stays, because the tool author declared free-form input;
// closing it would reject calls the author declared valid. A node whose own `unevaluatedProperties`
// is not `false` stays open too, because that keyword already decides which extra keys it allows.
// `unevaluatedProperties: false` forbids them, so the node still needs the literal keyword for a
// consumer that ignores it.
export const schemaMapKeywords: ReadonlySet<string> = new Set(['patternProperties', 'properties']);

export const schemaArrayKeywords: ReadonlySet<string> = new Set(['prefixItems']);

export const schemaValueKeywords: ReadonlySet<string> = new Set([
  'additionalItems',
  'additionalProperties',
  'items',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

// A subschema under one of these keywords narrows the instance instead of asserting it, or combines
// with sibling schemas. Closing any object below one of them could accept an input the negation or
// condition rejects, or reject a value a sibling declares, so the whole subtree stays as written.
// The schema form of `dependencies` and `dependentSchemas` combines with the whole instance, so its
// subschemas stay open as well. `contains` constrains the same array items as `items` and
// `prefixItems`, so a closed `contains` would stop an item the sibling schema declares from matching.
export const schemaUnassertedKeywords: ReadonlySet<string> = new Set([
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

// A node that combines with a sibling schema cannot close itself: additionalProperties only counts
// the properties next to it, so a property a sibling declares would be rejected. A `$ref` sibling
// likewise leaves the node's own properties incomplete.
export const schemaCombiningKeywords: ReadonlySet<string> = new Set([
  '$ref',
  'allOf',
  'anyOf',
  'dependencies',
  'dependentSchemas',
  'else',
  'oneOf',
  'then',
]);

const declaresObject = (value: Record<string, unknown>): boolean => {
  const type = Object.hasOwn(value, 'type') ? value['type'] : undefined;

  if (type === 'object') {
    return true;
  }

  if (Array.isArray(type) && type.includes('object')) {
    return true;
  }

  const declaresKeys =
    Object.hasOwn(value, 'properties') || Object.hasOwn(value, 'patternProperties');

  return type === undefined && declaresKeys;
};

// `const` and `enum` name instance values, so closing the node would reject the object it requires.
const requiresObjectValue = (value: Record<string, unknown>): boolean => {
  const constant = Object.hasOwn(value, 'const') ? value['const'] : undefined;
  const entries = Object.hasOwn(value, 'enum') ? value['enum'] : undefined;
  const requiresConstant = isRecord(constant);
  const requiresEntry = Array.isArray(entries) && entries.some((entry) => isRecord(entry));

  return requiresConstant || requiresEntry;
};

const cyclicSchemaMessage =
  'Cannot install strict tool parameters: the parameters schema refers to itself.';

const cloneCache = (
  walk: SchemaWalk,
  asserted: boolean,
  role: CloneRole,
): WeakMap<object, unknown> => {
  if (role === 'map') {
    return asserted ? walk.assertedMapClones : walk.unassertedMapClones;
  }

  return asserted ? walk.assertedClones : walk.unassertedClones;
};

const beginClone = (value: SchemaNode, walk: SchemaWalk): void => {
  if (walk.visiting.has(value)) {
    throw new Error(cyclicSchemaMessage);
  }

  walk.visiting.add(value);
};

const finishClone = (
  value: SchemaNode,
  asserted: boolean,
  role: CloneRole,
  walk: SchemaWalk,
  clone: unknown,
): void => {
  walk.visiting.delete(value);
  cloneCache(walk, asserted, role).set(value, clone);
};

// The cache and cycle bookkeeping every clone shares, so the build callback only makes the copy.
const memoizedClone = (
  value: SchemaNode,
  asserted: boolean,
  role: CloneRole,
  walk: SchemaWalk,
  build: () => unknown,
): unknown => {
  const cache = cloneCache(walk, asserted, role);
  const cached = cache.get(value);

  if (cached !== undefined) {
    return cached;
  }

  beginClone(value, walk);

  const clone = build();

  finishClone(value, asserted, role, walk, clone);

  return clone;
};

const strictSchemaMap = (value: unknown, asserted: boolean, walk: SchemaWalk): unknown => {
  if (!isRecord(value)) {
    return value;
  }

  return memoizedClone(value, asserted, 'map', walk, () => {
    const clone: Record<PropertyKey, unknown> = { ...value };

    for (const key of Object.keys(value)) {
      clone[key] = walk.visit(value[key], asserted);
    }

    return clone;
  });
};

const strictSchemaChild = (
  key: string,
  child: unknown,
  asserted: boolean,
  walk: SchemaWalk,
): unknown => {
  if (schemaUnassertedKeywords.has(key)) {
    return walk.visit(child, false);
  }

  if (schemaMapKeywords.has(key)) {
    return strictSchemaMap(child, asserted, walk);
  }

  if (schemaArrayKeywords.has(key)) {
    return Array.isArray(child) ? walk.visit(child, asserted) : child;
  }

  if (schemaValueKeywords.has(key)) {
    return walk.visit(child, asserted);
  }

  return child;
};

const strictSchemaArray = (
  value: readonly unknown[],
  asserted: boolean,
  walk: SchemaWalk,
): unknown =>
  memoizedClone(value, asserted, 'schema', walk, () => {
    const clone: unknown[] = [];

    for (const item of value) {
      clone.push(walk.visit(item, asserted));
    }

    return clone;
  });

const strictSchemaObject = (
  value: Record<string, unknown>,
  asserted: boolean,
  walk: SchemaWalk,
): unknown =>
  memoizedClone(value, asserted, 'schema', walk, () => {
    const clone: Record<PropertyKey, unknown> = { ...value };

    for (const key of Object.keys(value)) {
      clone[key] = strictSchemaChild(key, value[key], asserted, walk);
    }

    const combinesWithSibling = Object.keys(value).some((keyword) =>
      schemaCombiningKeywords.has(keyword),
    );

    const allowsUndeclaredKeys =
      Object.hasOwn(value, 'unevaluatedProperties') && value['unevaluatedProperties'] !== false;

    const closesObject = asserted && declaresObject(value);

    const keepsObjectOpen =
      requiresObjectValue(value) || combinesWithSibling || allowsUndeclaredKeys;

    if (closesObject && !keepsObjectOpen) {
      const declaresAdditionalProperties =
        Object.hasOwn(value, 'additionalProperties') && value['additionalProperties'] !== undefined;

      if (!declaresAdditionalProperties) {
        clone['additionalProperties'] = false;
      }
    }

    return clone;
  });

const strictSchemaValue = (value: unknown, asserted: boolean, walk: SchemaWalk): unknown => {
  if (Array.isArray(value)) {
    return strictSchemaArray(value, asserted, walk);
  }

  if (!isRecord(value)) {
    return value;
  }

  return strictSchemaObject(value, asserted, walk);
};

export const strictToolParameters = <Schema extends TSchema>(schema: Schema): Schema => {
  const walk: SchemaWalk = {
    assertedClones: new WeakMap(),
    unassertedClones: new WeakMap(),
    assertedMapClones: new WeakMap(),
    unassertedMapClones: new WeakMap(),
    visiting: new WeakSet(),
    visit: (value, asserted) => strictSchemaValue(value, asserted, walk),
  };

  const strict = strictSchemaValue(schema, true, walk);

  // The clone holds every key, so its values win. Spreading the schema keeps the caller's type
  // without a type assertion, which this package's lint forbids.
  return isRecord(strict) ? { ...schema, ...strict } : schema;
};

const installedApis = new WeakMap<ExtensionAPI, InstalledWrapper>();

const notWritableMessage =
  'Cannot install strict tool parameters: registerTool is not writable on this API.';

const notReadableMessage =
  'Cannot install strict tool parameters: registerTool is not readable on this API.';

const notCallableMessage =
  'Cannot install strict tool parameters: registerTool is not callable on this API.';

const probeRefusedMessage =
  'Cannot install strict tool parameters: the host refused the registration probe.';

const descriptorOf = (target: ExtensionAPI, key: string): PropertyDescriptor | undefined => {
  const visited = new Set<object>();
  let current: object | null = target;

  // An extensible proxy may return itself from `getPrototypeOf`, so a chain that does not advance
  // must stop instead of looping.
  while (current !== null && !visited.has(current)) {
    visited.add(current);

    const descriptor = Object.getOwnPropertyDescriptor(current, key);

    if (descriptor !== undefined) {
      return descriptor;
    }

    const prototype: unknown = Object.getPrototypeOf(current);
    const isObjectPrototype = typeof prototype === 'object' || typeof prototype === 'function';
    const isPrototype = prototype !== null && isObjectPrototype;

    current = isPrototype ? prototype : null;
  }

  return undefined;
};

const restoreRegisterTool = (pi: ExtensionAPI, original: RegisterToolReturningValue): void => {
  try {
    pi.registerTool = original;
  } catch {
    // The install failure still reports why the wrapper did not stay installed.
  }
};

const failInstall = (
  pi: ExtensionAPI,
  original: RegisterToolReturningValue,
  message: string,
  cause?: unknown,
): never => {
  restoreRegisterTool(pi, original);

  throw cause === undefined ? new Error(message) : new Error(message, { cause });
};

// An accessor or proxy trap may throw or return a different function on each read, so read the
// property once and bind the value that was checked.
const readRegisterTool = (pi: ExtensionAPI): RegisterToolReturningValue => {
  const host: RegisterToolHost = pi;
  let current: RegisterToolReturningValue | undefined;

  try {
    current = host.registerTool;
  } catch (error) {
    throw new Error(notReadableMessage, { cause: error });
  }

  if (typeof current !== 'function') {
    throw new TypeError('Cannot install strict tool parameters: registerTool is not a function.');
  }

  return current;
};

const probeError = new Error('the strict registration probe reached the wrapper');

const probeMarker: unique symbol = Symbol('strict tool parameters probe');

// The probe carries the fields a host may read before it delegates, but no parameter schema: the
// host's own registration refuses such a tool, so a readback that bypasses the wrapper cannot
// register the probe.
const probeFields = {
  name: 'tau-strict-tool-parameters-probe',
  label: 'strict tool parameters probe',
  description: 'A tool used once to confirm that the strict registration wrapper is installed.',
  execute: () => Promise.resolve(undefined),
};

const createProbe = (): InstallProbe => ({
  reached: false,
  tool: { [probeMarker]: true, ...probeFields },
});

const isProbeTool = (value: unknown): value is ProbeTool => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return probeMarker in value && value[probeMarker] === true;
};

const isProbeCall = (value: unknown): value is (tool: unknown) => unknown =>
  typeof value === 'function';

const probeOutcome = (readBack: unknown, probe: InstallProbe): ProbeOutcome => {
  if (!isProbeCall(readBack)) {
    return 'unconfirmed';
  }

  let result: unknown;

  try {
    result = readBack(probe.tool);
  } catch (error) {
    if (probe.reached) {
      return 'reached';
    }

    // Another install's wrapper throws the same error, so it refused the probe without confirming
    // this install's wrapper.
    return error === probeError ? 'unconfirmed' : 'refused';
  }

  // A host that defers the call cannot confirm the wrapper, and its rejection must not escape.
  void Promise.resolve(result).catch(() => undefined);

  return probe.reached ? 'reached' : 'unconfirmed';
};

// An inherited accessor accepts the value through its setter and creates no own property, and a
// proxy trap may throw while it reports one, so read the descriptor through the chain.
const verifyInstalled = (
  pi: ExtensionAPI,
  wrapper: RegisterToolReturningValue,
  original: RegisterToolReturningValue,
  probe: InstallProbe,
): boolean => {
  let descriptor: PropertyDescriptor | undefined;

  try {
    descriptor = descriptorOf(pi, 'registerTool');
  } catch (error) {
    failInstall(pi, original, notReadableMessage, error);
  }

  if (descriptor?.value === wrapper) {
    return true;
  }

  const host: RegisterToolHost = pi;
  let readBack: unknown;

  try {
    readBack = descriptor?.get === undefined ? host.registerTool : descriptor.get.call(pi);
  } catch (error) {
    failInstall(pi, original, notReadableMessage, error);
  }

  if (typeof readBack !== 'function') {
    failInstall(pi, original, notCallableMessage);
  }

  if (readBack === original) {
    failInstall(pi, original, notWritableMessage);
  }

  if (readBack === wrapper) {
    return true;
  }

  const outcome = probeOutcome(readBack, probe);

  if (outcome === 'refused') {
    failInstall(pi, original, probeRefusedMessage);
  }

  if (outcome === 'unconfirmed') {
    failInstall(pi, original, notWritableMessage);
  }

  return false;
};

const installWrapper = (pi: ExtensionAPI): InstalledWrapper => {
  const original = readRegisterTool(pi);
  const registered = original.bind(pi);
  const probe = createProbe();

  const wrapper: RegisterToolReturningValue = (tool) => {
    if (isProbeTool(tool)) {
      // A host may copy the definition before it delegates, so the marker, not the object, proves
      // the call reached this install's wrapper.
      probe.reached = true;

      throw probeError;
    }

    const strictTool: typeof tool = { ...tool, parameters: strictToolParameters(tool.parameters) };

    // A tool may inherit a member such as `execute`, so keep the prototype the caller supplied.
    Reflect.setPrototypeOf(strictTool, Reflect.getPrototypeOf(tool));

    return registered(strictTool);
  };

  try {
    pi.registerTool = wrapper;
  } catch (error) {
    throw new Error(notWritableMessage, { cause: error });
  }

  return { wrapper, stable: verifyInstalled(pi, wrapper, original, probe) };
};

// The host may replace `registerTool` after the install, so read it again before trusting the
// recorded wrapper. A read that throws or is not a function cannot be the installed wrapper.
const currentRegisterTool = (pi: ExtensionAPI): RegisterToolReturningValue | undefined => {
  const host: RegisterToolHost = pi;
  let current: RegisterToolReturningValue | undefined;

  try {
    current = host.registerTool;
  } catch {
    return undefined;
  }

  return typeof current === 'function' ? current : undefined;
};

// The host may replace `registerTool` after the install, so a readable value that differs from the
// recorded wrapper means the host replaced it. A read that throws or yields no function cannot prove
// a replacement, and an unstable read cannot show one at all, so both keep the install.
const stillInstalled = (installed: InstalledWrapper | undefined, pi: ExtensionAPI): boolean => {
  if (installed === undefined) {
    return false;
  }

  if (!installed.stable) {
    return true;
  }

  const current = currentRegisterTool(pi);

  return current === undefined || current === installed.wrapper;
};

// Wraps `registerTool` once per API. Every tool registered through that API after this call has
// strict parameters, including tools that another extension registers.
export const strictToolRegistration = (pi: ExtensionAPI): void => {
  if (stillInstalled(installedApis.get(pi), pi)) {
    return;
  }

  installedApis.set(pi, installWrapper(pi));
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
