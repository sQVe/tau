import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Tool } from '@earendil-works/pi-ai';
import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fixtureLoadout } from '../src/extensions/subagents/fixtures/loadout.js';
import { workerArguments } from '../src/extensions/subagents/workerCommand.js';
import {
  isRecord,
  schemaArrayKeywords,
  schemaCombiningKeywords,
  schemaMapKeywords,
  schemaUnassertedKeywords,
  schemaValueKeywords,
} from '../src/schema.js';
import { skillTools } from '../src/skillTools.js';
import tauRegistration from '../src/tau/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

interface Registration {
  name: string;
  register: (pi: ExtensionAPI) => unknown;
  environment: Readonly<Record<string, string | undefined>>;
}

interface SchemaChild {
  path: string;
  value: unknown;
}

// `unicorn/no-thenable` reads a literal `then` key as a promise method, so spell the JSON Schema
// keyword from parts.
const thenKeyword = ['the', 'n'].join('');

// JSON Schema treats a node as an object when its type includes `object`, or when it declares
// `properties` or `patternProperties` without a type. This predicate is written from that rule, not
// from the production helper, so a gap in production shows up here instead of being copied.
const isObjectNode = (value: Record<string, unknown>): boolean => {
  const type = value['type'];

  const isObjectType = type === 'object';
  const isObjectTypeList = Array.isArray(type) && type.includes('object');
  const declaresKeys = 'properties' in value || 'patternProperties' in value;
  const declaresTypelessKeys = type === undefined && declaresKeys;

  return isObjectType || isObjectTypeList || declaresTypelessKeys;
};

// Spelled out here rather than read from production, so a change to the combining keywords fails
// the pin below.
const localCombiningKeywords: ReadonlySet<string> = new Set([
  '$ref',
  'allOf',
  'anyOf',
  'dependencies',
  'dependentSchemas',
  'else',
  'oneOf',
  'then',
]);

const hasObjectEnumValue = (value: Record<string, unknown>): boolean => {
  const entries = value['enum'];

  return Array.isArray(entries) && entries.some((entry) => isRecord(entry));
};

const isOpenObject = (value: Record<string, unknown>): boolean => {
  const additionalProperties = value['additionalProperties'];

  // An explicit true is the tool author's opt-out, so production leaves it as written.
  const hasDefaultAdditionalProperties = additionalProperties === undefined;

  // Production keeps a combining node and an object-valued const or enum open, because closing
  // either would reject a value the schema declares.
  const combinesWithSibling = Object.keys(value).some((key) => localCombiningKeywords.has(key));

  const requiresObjectValue = isRecord(value['const']) || hasObjectEnumValue(value);

  const keepsObjectOpen = combinesWithSibling || requiresObjectValue;

  return isObjectNode(value) && hasDefaultAdditionalProperties && !keepsObjectOpen;
};

// Spelled out here rather than read from production, so a keyword production changes fails the pin
// below and forces this oracle to walk it too.
const localMapKeywords: ReadonlySet<string> = new Set(['patternProperties', 'properties']);

const localArrayKeywords: ReadonlySet<string> = new Set(['prefixItems']);

const localValueKeywords: ReadonlySet<string> = new Set([
  'additionalItems',
  'additionalProperties',
  'items',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

// Production leaves every object under a keyword that narrows the instance or combines with sibling
// schemas open, because closing one could accept an input the negation rejects or reject a value a
// sibling declares.
const localUnassertedKeywords: ReadonlySet<string> = new Set([
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

const schemaChildren = (value: Record<string, unknown>, path: string): SchemaChild[] => {
  const children: SchemaChild[] = [];

  for (const [key, child] of Object.entries(value)) {
    if (localUnassertedKeywords.has(key)) {
      continue;
    }

    if (localMapKeywords.has(key) && isRecord(child)) {
      for (const [name, entry] of Object.entries(child)) {
        children.push({ path: `${path}/${key}/${name}`, value: entry });
      }
    } else if (localArrayKeywords.has(key) && Array.isArray(child)) {
      for (const [index, entry] of child.entries()) {
        children.push({ path: `${path}/${key}/${index}`, value: entry });
      }
    } else if (localValueKeywords.has(key)) {
      children.push({ path: `${path}/${key}`, value: child });
    }
  }

  return children;
};

const objectProblems = (toolName: string, value: unknown, path: string): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectProblems(toolName, item, `${path}/${index}`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const own = isOpenObject(value) ? [`${toolName} parameters${path}`] : [];

  const nested = schemaChildren(value, path).flatMap((child) =>
    objectProblems(toolName, child.value, child.path),
  );

  return [...own, ...nested];
};

const toolNamed = (tools: Tool[], name: string): Tool => {
  const tool = tools.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    throw new Error(`The ${name} tool was not registered.`);
  }

  return tool;
};

const workerEntryPoints = (): string[] => {
  const argv = workerArguments('/tmp/session.jsonl', fixtureLoadout('/tmp'), [], skillTools);

  return argv.filter((_argument, index) => argv[index - 1] === '-e');
};

const registrationFor = async (path: string): Promise<Registration> => {
  const module = (await import(pathToFileURL(path).href)) as {
    default: (pi: ExtensionAPI) => unknown;
  };

  return {
    name: basename(path),
    register: module.default,
    environment: { TAU_ROLE: 'worker', TAU_WORKER_RECORD: 'worker-record' },
  };
};

const registrations = async (): Promise<Registration[]> => {
  const entryPoints = workerEntryPoints().map(registrationFor);
  const workerRegistrations = await Promise.all(entryPoints);

  return [
    {
      name: 'tau root',
      register: tauRegistration,
      environment: { TAU_ROLE: undefined, TAU_WORKER_RECORD: undefined },
    },
    ...workerRegistrations,
  ];
};

const toolsOf = async (registration: Registration): Promise<Tool[]> => {
  vi.stubEnv('TAU_ROLE', registration.environment.TAU_ROLE);
  vi.stubEnv('TAU_WORKER_RECORD', registration.environment.TAU_WORKER_RECORD);

  const fake = fakeExtensionApi();

  try {
    await registration.register(fake.pi);

    return [...fake.tools.values()] as Tool[];
  } finally {
    vi.unstubAllEnvs();
  }
};

// The Tau root and worker entry points register these tools synchronously. A tool registered only
// for another role, such as the `architect` answer tool under TAU_ROLE=architect, or from an event
// handler, such as `handover_question` from `before_agent_start`, is outside this collection.
const registeredTools = async (): Promise<{ registration: string; tools: Tool[] }[]> => {
  const all: { registration: string; tools: Tool[] }[] = [];

  // Each registration reads the environment that `toolsOf` stubs, so register one at a time.
  for (const registration of await registrations()) {
    all.push({ registration: registration.name, tools: await toolsOf(registration) });
  }

  return all;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

// Production leaves `$ref` and the definitions it reaches as written, so an argument object reached
// through a reference keeps its keys open. No registered tool may use that shape while it is open.
const referencePaths = (value: unknown, path: string): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => referencePaths(item, `${path}/${index}`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const own = ['$ref', '$defs', 'definitions']
    .filter((key) => key in value)
    .map((key) => `${path}/${key}`);

  return [
    ...own,
    ...Object.entries(value).flatMap(([key, child]) => referencePaths(child, `${path}/${key}`)),
  ];
};

it('registers no tool whose parameters reach an argument object through $ref', async () => {
  const offenders = (await registeredTools()).flatMap(({ registration, tools }) =>
    tools.flatMap((tool) => referencePaths(tool.parameters, `${registration}:${tool.name}`)),
  );

  expect(offenders).toEqual([]);
});

it('pins the local schema keyword sets to the production sets', () => {
  expect([...localMapKeywords].toSorted()).toEqual([...schemaMapKeywords].toSorted());
  expect([...localArrayKeywords].toSorted()).toEqual([...schemaArrayKeywords].toSorted());
  expect([...localValueKeywords].toSorted()).toEqual([...schemaValueKeywords].toSorted());
  expect([...localUnassertedKeywords].toSorted()).toEqual([...schemaUnassertedKeywords].toSorted());
  expect([...localCombiningKeywords].toSorted()).toEqual([...schemaCombiningKeywords].toSorted());
});

it('registers the tools of the Tau root and the worker entry points it checks', async () => {
  const tools = await registeredTools();
  const names = tools.map(({ registration }) => registration);

  expect(names).toContain('tau root');
  expect(names).toEqual(expect.arrayContaining(['workerExtension.ts', 'workerRecord.ts']));

  const root = tools.find(({ registration }) => registration === 'tau root');

  expect(root?.tools.length).toBeGreaterThan(0);

  const worker = tools.find(({ registration }) => registration === 'workerExtension.ts');
  const workerNames = (worker?.tools ?? []).map(({ name }) => name);

  expect(workerNames).toEqual(expect.arrayContaining(['subagent_report', 'subagent_question']));

  const record = tools.find(({ registration }) => registration === 'workerRecord.ts');

  expect(record?.tools.map(({ name }) => name)).toEqual(['verification_record']);
});

// Providers and MCP bridges refuse a tool whose parameters are not an object at the top, such as a
// union of objects.
it('gives every registered tool an object schema at the top of its parameters', async () => {
  const tools = await registeredTools();

  const problems = tools.flatMap(({ registration, tools: registered }) =>
    registered.flatMap((tool) => {
      const { type } = tool.parameters as { type?: unknown };

      return type === 'object' ? [] : [`${registration} ${tool.name}`];
    }),
  );

  expect(problems).toEqual([]);
});

// Production leaves an object under an unasserted keyword as written, because closing it could
// reject a value a sibling declares. This test covers the asserted positions, where production
// closes the node itself.
it('sets literal additionalProperties false on every object schema in an asserted position', async () => {
  const tools = await registeredTools();

  const problems = tools.flatMap(({ tools: registered }) =>
    registered.flatMap((tool) => objectProblems(tool.name, tool.parameters, '')),
  );

  expect(problems).toEqual([]);
});

it('reports a loose nested object with its tool and path', () => {
  const loose = {
    type: 'object',
    additionalProperties: false,
    properties: {
      outer: { type: 'object' },
      schemaValue: { type: 'object', additionalProperties: { type: 'string' } },
    },
  };

  expect(objectProblems('sample', loose, '')).toEqual(['sample parameters/properties/outer']);
});

it.each([
  { name: 'an undefined additionalProperties', additionalProperties: undefined, problem: true },
  { name: 'a true additionalProperties', additionalProperties: true, problem: false },
  { name: 'a false additionalProperties', additionalProperties: false, problem: false },
  {
    name: 'a schema-valued additionalProperties',
    additionalProperties: { type: 'string' },
    problem: false,
  },
])('decides $name', ({ additionalProperties, problem }) => {
  const schema = { type: 'object', additionalProperties };
  const expected = problem ? ['sample parameters'] : [];

  expect(objectProblems('sample', schema, '')).toEqual(expected);
});

it('ignores an object value in an annotation keyword', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    default: { type: 'object' },
    examples: [{ type: 'object' }],
  };

  expect(objectProblems('sample', schema, '')).toEqual([]);
});

it('reports a patternProperties object without a closed additionalProperties', () => {
  const map = {
    type: 'object',
    patternProperties: { '^[a-z]+$': { type: 'string' } },
  };

  expect(objectProblems('sample', map, '')).toEqual(['sample parameters']);
});

it.each([
  { name: 'a type list that includes object', schema: { type: ['object', 'null'] } },
  { name: 'properties without a type', schema: { properties: {} } },
  { name: 'patternProperties without a type', schema: { patternProperties: {} } },
])('reports $name as an open object', ({ schema }) => {
  expect(objectProblems('sample', schema, '')).toEqual(['sample parameters']);
});

it('accepts an object schema under not, if, then, else, and allOf', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    not: { type: 'object' },
    if: { properties: { value: { type: 'string' } } },
    [thenKeyword]: { properties: { value: { type: 'string' } } },
    else: { properties: { value: { type: 'string' } } },
    allOf: [{ properties: { value: { type: 'string' } } }],
  };

  expect(objectProblems('sample', schema, '')).toEqual([]);
});

it('accepts a loose object nested under a branch', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { detail: {} },
    allOf: [{ properties: { detail: { type: 'object', properties: {} } } }],
  };

  expect(objectProblems('sample', schema, '')).toEqual([]);
});

it('accepts properties on a node whose declared type is not an object', () => {
  const schema = { type: 'string', properties: { value: { type: 'string' } } };

  expect(objectProblems('sample', schema, '')).toEqual([]);
});

it('accepts a node that combines with a sibling schema', () => {
  const schema = { type: 'object', allOf: [{ properties: { value: { type: 'string' } } }] };

  expect(objectProblems('sample', schema, '')).toEqual([]);
});

it('accepts an object-valued const or enum that production keeps open', () => {
  const constant = { type: 'object', const: { value: 'x' } };
  const enumerated = { type: 'object', enum: [{ value: 'x' }] };

  expect(objectProblems('sample', constant, '')).toEqual([]);
  expect(objectProblems('sample', enumerated, '')).toEqual([]);
});

it('refuses an undeclared handover start field', async () => {
  const tools = await registeredTools();

  const handover = toolNamed(
    tools.flatMap(({ tools: registered }) => registered),
    'handover',
  );

  expect(() => {
    validateToolArguments(handover, {
      type: 'toolCall',
      id: 'call',
      name: 'handover',
      arguments: {
        action: 'start',
        file: '.tau/handovers/message.md',
        folder: '/repository',
        name: 'Next steps',
        modelId: 'claude-bridge/claude-opus-5-5',
      },
    });
  }).toThrow('modelId: unknown field');
});
