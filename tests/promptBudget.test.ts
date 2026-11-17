import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bundledProfileDirectory, resolveProfile } from '../src/extensions/subagents/profiles.js';
import { qaGuidePath } from '../src/extensions/subagents/qaBrief.js';
import type { Loadout } from '../src/extensions/subagents/types.js';
import workerExtension, {
  workerSystemPrompt,
} from '../src/extensions/subagents/workerExtension.js';
import { workerTools } from '../src/extensions/subagents/workerTools.js';
import { releaseRegistration } from '../src/inbox/inbox.js';
import type { RoleKind } from '../src/role.js';
import { managerGuidelines } from '../src/roleGuidelines.js';
import { skillTools } from '../src/skillTools.js';
import tauExtension from '../src/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

const oneActionBudget = 1000;
const multiActionBudget = 3000;

// Tools over budget today, each with its current description length as its own ceiling.
const descriptionExceptions: Readonly<Record<string, number>> = {};

// Each ceiling caps a session at about its measured size, so a cut must lower it. The target is
// beside each ceiling.
const sessionCeilings: Readonly<Record<string, number>> = {
  lead: 57_907, // target 38,000
  architect: 54_278,
  worker: 22_387, // target 14,000
  reviewer: 17_841, // target 11,000
  checker: 17_994,
  qa: 14_670, // target 9,000
  browser: 12_828, // target 9,000
  scout: 12_387, // target 9,000
};

const profileNames = ['worker', 'reviewer', 'checker', 'qa', 'browser', 'scout'];
const skillsDirectory = fileURLToPath(new URL('../src/skills/', import.meta.url));

const isMultiAction = (tool: ToolDefinition): boolean =>
  Object.hasOwn((tool.parameters as { properties?: object }).properties ?? {}, 'action');

const toolSize = (tool: ToolDefinition): number =>
  tool.description.length + JSON.stringify(tool.parameters).length;

const toolsSize = (tools: ToolDefinition[]): number =>
  tools.reduce((total, tool) => total + toolSize(tool), 0);

const loadTools = async (role: RoleKind, agentDirectory: string) => {
  const tauRole = role === 'lead' ? undefined : role;
  vi.stubEnv('TAU_ROLE', tauRole);
  const workerRecord = role === 'worker' ? 'worker-record' : '';
  vi.stubEnv('TAU_WORKER_RECORD', workerRecord);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  if (role !== 'worker') {
    vi.stubEnv('HC_TERMINAL_ID', 'manager');
  }

  const fake = fakeExtensionApi();

  await tauExtension(fake.pi);
  // No session starts, so no session_shutdown releases the inbox that loading Tau claimed.
  releaseRegistration();

  if (role === 'worker') {
    workerExtension(fake.pi);
  }

  vi.unstubAllEnvs();

  return fake;
};

const roleOptions = {
  loginCommand: undefined,
  qaProcedurePath: undefined,
  qaGuidePath,
};

const roleSession = async (role: 'lead' | 'architect', agentDirectory: string) => {
  const fake = await loadTools(role, agentDirectory);

  const event = {
    systemPromptOptions: { appendSystemPrompt: '', selectedTools: [...fake.tools.keys()] },
  };

  for (const handler of fake.handlers.get('before_agent_start') ?? []) {
    await handler(event as never, {} as ExtensionContext);
  }

  const prompt = event.systemPromptOptions.appendSystemPrompt;
  const guidelines = managerGuidelines(role, roleOptions);
  const missingGuidelines = guidelines.filter((guideline) => !prompt.includes(guideline));

  if (missingGuidelines.length > 0) {
    throw new Error(
      `${role} prompt lacks ${missingGuidelines.length} of ${guidelines.length} delegation guidelines`,
    );
  }

  const tools = [...fake.tools.values()];

  return { tools, size: prompt.length + toolsSize(tools), prompt };
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
  const fake = await loadTools('worker', directory);
  const loadout = loadoutFor(profileName, directory);
  const names = new Set(workerTools(loadout, skillTools));

  const tauTools = workerTools(
    { tools: [], skills: loadout.skills, role: loadout.role },
    skillTools,
  );

  const missing = tauTools.filter((name) => !fake.tools.has(name));

  if (missing.length > 0) {
    throw new Error(`${profileName} worker does not register: ${missing.join(', ')}`);
  }

  const tools = [...fake.tools.values()].filter((tool) => names.has(tool.name));
  const prompt = await workerSystemPrompt(loadout);

  return { tools, size: prompt.length + toolsSize(tools), prompt };
};

const sessions = new Map<string, { tools: ToolDefinition[]; size: number; prompt: string }>();
let directory = '';

beforeAll(async () => {
  // The directory is shared by every test, so `afterAll` removes it.
  directory = mkdtempSync(join(tmpdir(), 'tau-prompt-budget-'));
  sessions.set('lead', await roleSession('lead', directory));
  sessions.set('architect', await roleSession('architect', directory));

  for (const name of profileNames) {
    sessions.set(name, await workerSession(name, directory));
  }
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const allTools = (): ToolDefinition[] => {
  const toolEntries = [...sessions.values()]
    .flatMap((session) => session.tools)
    .map((tool) => [tool.name, tool] as const);

  return [...new Map(toolEntries).values()];
};

describe('prompt budget', () => {
  it('a lead prompt holds the lead rules and no architect rules', () => {
    const prompt = sessions.get('lead')?.prompt ?? '';
    const lead = managerGuidelines('lead', roleOptions);
    const architect = managerGuidelines('architect', roleOptions);
    const architectOnly = architect.filter((guideline) => !lead.includes(guideline));

    expect(lead.filter((guideline) => !prompt.includes(guideline))).toEqual([]);
    expect(architectOnly.filter((guideline) => prompt.includes(guideline))).toEqual([]);
  });

  it('an architect prompt holds the architect rules', () => {
    const prompt = sessions.get('architect')?.prompt ?? '';
    const lead = managerGuidelines('lead', roleOptions);
    const architect = managerGuidelines('architect', roleOptions);
    const leadOnly = lead.filter((guideline) => !architect.includes(guideline));

    expect(architect.filter((guideline) => !prompt.includes(guideline))).toEqual([]);
    expect(leadOnly.filter((guideline) => prompt.includes(guideline))).toEqual([]);
  });

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
    const toolEntries = allTools().map((tool) => [tool.name, tool] as const);
    const tools = new Map(toolEntries);

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
    const sessionCeilingNames = Object.keys(sessionCeilings).toSorted();
    expect([...sessions.keys()].toSorted()).toEqual(sessionCeilingNames);

    const over = [...sessions]
      .filter(([name, { size }]) => size > (sessionCeilings[name] ?? 0))
      .map(([name, { size }]) => `${name}: ${size} characters, ceiling ${sessionCeilings[name]}`);

    expect(over).toEqual([]);
  });
});
