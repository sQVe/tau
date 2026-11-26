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
  schemaMapKeywords,
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

const isOpenObject = (value: Record<string, unknown>): boolean => {
  const additionalProperties = value['additionalProperties'];

  const hasDefaultAdditionalProperties =
    additionalProperties === undefined || additionalProperties === true;

  return isObjectNode(value) && hasDefaultAdditionalProperties;
};

// Production leaves every object under `not` or `if` open, because closing one would accept inputs
// the tool rejects.
const unassertedKeywords = new Set(['if', 'not']);

const schemaChildren = (value: Record<string, unknown>, path: string): SchemaChild[] => {
  const children: SchemaChild[] = [];

  for (const [key, child] of Object.entries(value)) {
    if (schemaMapKeywords.has(key) && isRecord(child)) {
      for (const [name, entry] of Object.entries(child)) {
        children.push({ path: `${path}/${key}/${name}`, value: entry });
      }
    } else if (schemaArrayKeywords.has(key) && Array.isArray(child)) {
      for (const [index, entry] of child.entries()) {
        children.push({ path: `${path}/${key}/${index}`, value: entry });
      }
    } else if (schemaValueKeywords.has(key) && !unassertedKeywords.has(key)) {
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

it('enumerates the Tau root and every worker entry point', async () => {
  const tools = await registeredTools();
  const names = tools.map(({ registration }) => registration);

  expect(names).toEqual([
    'tau root',
    'toolResultRedaction.ts',
    'workerBashGuard.ts',
    'workerExtension.ts',
    'inbox.ts',
    'workerRecord.ts',
  ]);

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

it('sets literal additionalProperties false on every object schema in every registered tool', async () => {
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
      outer: { type: 'object', additionalProperties: true },
      schemaValue: { type: 'object', additionalProperties: { type: 'string' } },
    },
  };

  expect(objectProblems('sample', loose, '')).toEqual(['sample parameters/properties/outer']);
});

it.each([
  { name: 'an undefined additionalProperties', additionalProperties: undefined, problem: true },
  { name: 'a true additionalProperties', additionalProperties: true, problem: true },
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

it('accepts an object schema under not and if', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    not: { type: 'object' },
    if: { properties: { value: { type: 'string' } } },
  };

  expect(objectProblems('sample', schema, '')).toEqual([]);
});

it('accepts properties on a node whose declared type is not an object', () => {
  const schema = { type: 'string', properties: { value: { type: 'string' } } };

  expect(objectProblems('sample', schema, '')).toEqual([]);
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
