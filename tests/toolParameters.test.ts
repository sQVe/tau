import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Tool } from '@earendil-works/pi-ai';
import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fixtureLoadout } from '../src/extensions/subagents/fixtures/loadout.js';
import { workerArguments } from '../src/extensions/subagents/workerCommand.js';
import { skillTools } from '../src/skillTools.js';
import tauRegistration from '../src/tau/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

interface Registration {
  name: string;
  register: (pi: ExtensionAPI) => unknown;
  environment: Readonly<Record<string, string | undefined>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMapSchema = (value: Record<string, unknown>): boolean => {
  const patternProperties = value['patternProperties'];

  return isRecord(patternProperties) && Object.keys(patternProperties).length > 0;
};

// A map schema constrains every key through patternProperties, so it needs no closed object.
const objectProblems = (toolName: string, value: unknown, path: string): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectProblems(toolName, item, `${path}/${index}`));
  }

  if (!isRecord(value)) {
    return [];
  }

  const own =
    value['type'] === 'object' && value['additionalProperties'] !== false && !isMapSchema(value)
      ? [`${toolName} parameters${path}`]
      : [];

  const nested = Object.entries(value).flatMap(([key, child]) =>
    objectProblems(toolName, child, `${path}/${key}`),
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

const registeredTools = async (): Promise<{ registration: string; tools: Tool[] }[]> =>
  Promise.all(
    (await registrations()).map(async (registration) => ({
      registration: registration.name,
      tools: await toolsOf(registration),
    })),
  );

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

  expect(objectProblems('sample', loose, '')).toEqual([
    'sample parameters/properties/outer',
    'sample parameters/properties/schemaValue',
  ]);
});

it('passes a map schema that uses patternProperties', () => {
  const map = {
    type: 'object',
    patternProperties: { '^[a-z]+$': { type: 'string' } },
  };

  expect(objectProblems('sample', map, '')).toEqual([]);
});

it('fails when a tool it needs is missing', () => {
  expect(() => toolNamed([], 'handover')).toThrow('The handover tool was not registered.');
});

it('refuses the past handover start model field on a schema without model', async () => {
  const tools = await registeredTools();

  const handover = toolNamed(
    tools.flatMap(({ tools: registered }) => registered),
    'handover',
  );

  const oldParameters = structuredClone(handover.parameters) as Record<string, unknown>;
  const properties = oldParameters['properties'];

  if (!isRecord(properties)) {
    throw new Error('The handover parameters have no properties.');
  }

  delete properties['model'];

  const oldTool = { ...handover, parameters: oldParameters } as Tool;

  expect(() => {
    validateToolArguments(oldTool, {
      type: 'toolCall',
      id: 'call',
      name: 'handover',
      arguments: {
        action: 'start',
        file: '.tau/handovers/message.md',
        folder: '/repository',
        name: 'Next steps',
        model: 'claude-bridge/claude-opus-5-5',
      },
    });
  }).toThrow('model: unknown field');
});
