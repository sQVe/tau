import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { delegationGuidelines } from '../src/extensions/subagents/managerPrompt.js';
import { bundledProfileDirectory, resolveProfile } from '../src/extensions/subagents/profiles.js';
import type { Loadout } from '../src/extensions/subagents/types.js';
import workerExtension, {
  workerSystemPrompt,
} from '../src/extensions/subagents/workerExtension.js';
import { workerTools } from '../src/extensions/subagents/workerTools.js';
import { skillTools } from '../src/skillTools.js';
import tauExtension from '../src/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

const oneActionBudget = 1000;
const multiActionBudget = 3000;

// Tools over budget today, each with its current description length as its own ceiling.
const descriptionExceptions: Readonly<Record<string, number>> = {
  ask_user_question: 2932,
  code_review: 6047,
  full_check: 1222,
  mutation_check: 1985,
  pr: 10_378,
  pr_feedback: 7812,
  stack: 4488,
  tracker_draft: 1900,
  tracker_evidence: 1246,
};

// Today's measured size rounded up to the next 100 characters. The target is beside each ceiling.
const sessionCeilings: Readonly<Record<string, number>> = {
  manager: 80_900, // target 38,000
  worker: 20_700, // target 14,000
  reviewer: 14_600, // target 11,000
  qa: 12_600, // target 9,000
  browser: 11_400, // target 9,000
  scout: 9700, // target 9,000
};

const profileNames = ['worker', 'reviewer', 'qa', 'browser', 'scout'];
const skillsDirectory = fileURLToPath(new URL('../src/skills/', import.meta.url));

const isMultiAction = (tool: ToolDefinition): boolean =>
  Object.hasOwn((tool.parameters as { properties?: object }).properties ?? {}, 'action');

const toolSize = (tool: ToolDefinition): number =>
  tool.description.length + JSON.stringify(tool.parameters).length;

const toolsSize = (tools: ToolDefinition[]): number =>
  tools.reduce((total, tool) => total + toolSize(tool), 0);

const loadTools = async (workerRecord: string, agentDirectory: string) => {
  vi.stubEnv('TAU_WORKER_RECORD', workerRecord);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  // A real manager runs inside herdr, which turns on the delegation guidelines.
  if (workerRecord === '') {
    vi.stubEnv('HERDR_ENV', '1');
    vi.stubEnv('HERDR_PANE_ID', 'parent');
    vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  }

  const fake = fakeExtensionApi();

  await tauExtension(fake.pi);

  if (workerRecord !== '') {
    workerExtension(fake.pi);
  }

  vi.unstubAllEnvs();

  return fake;
};

const managerSession = async (agentDirectory: string) => {
  const fake = await loadTools('', agentDirectory);

  const event = {
    systemPromptOptions: { appendSystemPrompt: '', selectedTools: [...fake.tools.keys()] },
  };

  for (const handler of fake.handlers.get('before_agent_start') ?? []) {
    await handler(event as never, {} as ExtensionContext);
  }

  const prompt = event.systemPromptOptions.appendSystemPrompt;
  const guidelines = delegationGuidelines(undefined);
  const missingGuidelines = guidelines.filter((guideline) => !prompt.includes(guideline));

  if (missingGuidelines.length > 0) {
    throw new Error(
      `manager prompt lacks ${missingGuidelines.length} of ${guidelines.length} delegation guidelines`,
    );
  }

  const tools = [...fake.tools.values()];

  return { tools, size: prompt.length + toolsSize(tools) };
};

const loadoutFor = (profileName: string, directory: string): Loadout => {
  const profile = resolveProfile(directory, directory, true, profileName);

  if (!profile) {
    throw new Error(`Bundled profile ${profileName} is missing from ${bundledProfileDirectory}.`);
  }

  return {
    role: profile.role,
    instructions: profile.instructions,
    tools: profile.tools,
    instructionSets: profile.instructionSets,
    skills: profile.skills.map((name) => join(skillsDirectory, name, 'SKILL.md')),
  } as Loadout;
};

const workerSession = async (profileName: string, directory: string) => {
  const fake = await loadTools('worker-record', directory);
  const loadout = loadoutFor(profileName, directory);
  const names = new Set(workerTools(loadout, skillTools));
  const tauTools = workerTools({ tools: [], skills: loadout.skills }, skillTools);
  const missing = tauTools.filter((name) => !fake.tools.has(name));

  if (missing.length > 0) {
    throw new Error(`${profileName} worker does not register: ${missing.join(', ')}`);
  }

  const tools = [...fake.tools.values()].filter((tool) => names.has(tool.name));
  const prompt = await workerSystemPrompt(loadout);

  return { tools, size: prompt.length + toolsSize(tools) };
};

const sessions = new Map<string, { tools: ToolDefinition[]; size: number }>();
let directory = '';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tau-prompt-budget-'));
  sessions.set('manager', await managerSession(directory));

  for (const name of profileNames) {
    sessions.set(name, await workerSession(name, directory));
  }
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const allTools = (): ToolDefinition[] => [
  ...new Map(
    [...sessions.values()].flatMap((session) => session.tools).map((tool) => [tool.name, tool]),
  ).values(),
];

describe('prompt budget', () => {
  it('keeps every tool description within its budget', () => {
    const over = allTools()
      .filter((tool) => !Object.hasOwn(descriptionExceptions, tool.name))
      .map((tool) => ({
        name: tool.name,
        length: tool.description.length,
        budget: isMultiAction(tool) ? multiActionBudget : oneActionBudget,
      }))
      .filter(({ length, budget }) => length > budget)
      .map(({ name, length, budget }) => `${name}: ${length} characters, budget ${budget}`);

    expect(over).toEqual([]);
  });

  it('keeps each excepted tool within its recorded length', () => {
    const tools = new Map(allTools().map((tool) => [tool.name, tool]));

    const over = Object.entries(descriptionExceptions)
      .map(([name, ceiling]) => ({ name, ceiling, length: tools.get(name)?.description.length }))
      .filter(({ length, ceiling }) => length === undefined || length > ceiling)
      .map(
        ({ name, ceiling, length }) =>
          `${name}: ${length ?? 'not registered'} characters, ceiling ${ceiling}`,
      );

    expect(over).toEqual([]);
  });

  it('keeps each session within its ceiling', () => {
    expect([...sessions.keys()].toSorted()).toEqual(Object.keys(sessionCeilings).toSorted());

    const over = [...sessions]
      .filter(([name, { size }]) => size > (sessionCeilings[name] ?? 0))
      .map(([name, { size }]) => `${name}: ${size} characters, ceiling ${sessionCeilings[name]}`);

    expect(over).toEqual([]);
  });
});
