import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { assignmentDirectory, writeAssignment } from '../src/extensions/subagents/assignment.js';
import type { Assignment } from '../src/extensions/subagents/assignment.js';
import { bundledProfileDirectory, resolveProfile } from '../src/extensions/subagents/profiles.js';
import { qaGuidePath } from '../src/extensions/subagents/qaBrief.js';
import type { Loadout } from '../src/extensions/subagents/types.js';
import workerExtension from '../src/extensions/subagents/workerExtension.js';
import { workerTools } from '../src/extensions/subagents/workerTools.js';
import type { RoleKind } from '../src/role/role.js';
import { managerGuidelines } from '../src/role/roleGuidelines.js';
import { skillTools } from '../src/skillTools.js';
import tauRegistration from '../src/tau/tau.js';
import { fakeExtensionApi } from './extensionApi.js';
import { createHcFake } from './hcFake.js';
import { writeStommeProject } from './stommeProjectHarness.js';

type Sessions = Map<string, { tools: ToolDefinition[]; size: number; prompt: string }>;

const oneActionBudget = 1000;
const multiActionBudget = 3000;

// Tools over budget today, each with its current description length as its own ceiling.
const descriptionExceptions: Readonly<Record<string, number>> = {};

// Each ceiling caps a session at its larger measured size, the empty folder or the adopted project.
// The test rejects only growth, so lower a ceiling by hand after a cut. The target is beside each
// ceiling.
const sessionCeilings: Readonly<Record<string, number>> = {
  lead: 63_757, // target 38,000
  architect: 60_595,
  worker: 28_041, // target 14,000
  reviewer: 23_494, // target 11,000
  checker: 23_647,
  qa: 17_503, // target 9,000
  browser: 15_656, // target 9,000
  scout: 15_215, // target 9,000
};

const profileNames = ['worker', 'reviewer', 'checker', 'qa', 'browser', 'scout'];
const skillsDirectory = fileURLToPath(new URL('../src/skills/', import.meta.url));
const checkoutDirectory = fileURLToPath(new URL('../', import.meta.url));

// A bundled guide's source line names its absolute path, and an adopted project's heading names the
// project root, so fixed tokens stand in for both. Otherwise the measured size would depend on where
// Tau is checked out and on the temporary folder of the host.
const measuredPrompt = (prompt: string, projectDirectory: string): string =>
  prompt.replaceAll(projectDirectory, '<project>').replaceAll(checkoutDirectory, '<tau>/');

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

  await tauRegistration(fake.pi);

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
    await handler(event as never, { cwd: agentDirectory } as ExtensionContext);
  }

  const prompt = measuredPrompt(event.systemPromptOptions.appendSystemPrompt, agentDirectory);
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
    harness: 'pi',
    profile: profileName,
    role: profile.role,
    model: 'faux/test',
    thinking: 'off',
    cwd: directory,
    agentDirectory: directory,
    permissions: 'trusted-full-tools',
    instructions: profile.instructions,
    tools: profile.tools,
    skills: profile.skills.map((name) => join(skillsDirectory, name, 'SKILL.md')),
    instructionSets: profile.instructionSets,
    packages: profile.packages,
  };
};

const safetyNetPath = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

const workerTerminal = 'worker-1';
const parentTerminal = 'manager-1';

const assignmentFor = (loadout: Loadout, directory: string): Assignment => {
  const assignmentId = randomUUID();
  const sessionId = randomUUID();

  return {
    version: 3,
    assignmentId,
    task: 'Measure the prompt.',
    acceptance: [],
    label: null,
    profile: loadout.profile,
    loadout,
    routing: null,
    packageSnapshot: null,
    session: {
      id: sessionId,
      file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`),
    },
    parentSession: join(directory, 'parent.jsonl'),
    cwd: directory,
    parentTerminal,
    deadline: Date.now() + 60_000,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: null,
    questions: [],
    report: null,
  };
};

const workerHookPrompt = async (loadout: Loadout, directory: string): Promise<string> => {
  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);

  try {
    const assignment = assignmentFor(loadout, directory);
    const hc = createHcFake();
    const toolNames = workerTools(loadout, skillTools);

    hc.reply(
      'get',
      JSON.stringify({
        address: workerTerminal,
        state: 'live',
        parent: parentTerminal,
        labels: {
          'tau.assignment': join(assignmentDirectory(assignment.assignmentId), 'assignment.json'),
        },
      }),
    );

    const api = fakeExtensionApi({
      exec: hc.exec,
      getThinkingLevel: () => 'off',
      getCommands: () => [
        { name: 'cc-safety-net', source: 'extension', sourceInfo: { path: safetyNetPath } },
      ],
      getAllTools: () => toolNames.map((name) => ({ name })),
      setActiveTools: () => undefined,
    } as unknown as Partial<ExtensionAPI>);

    const context = {
      sessionManager: { getBranch: () => [] },
      shutdown: () => undefined,
      cwd: directory,
      model: { provider: 'faux', id: 'test' },
      isProjectTrusted: () => true,
      isIdle: () => true,
      ui: { notify: () => undefined },
    } as unknown as ExtensionContext;

    workerExtension(api.pi);
    await writeAssignment(assignment);

    for (const handler of api.handlers.get('session_start') ?? []) {
      await handler({} as never, context);
    }

    const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools: [] } };

    for (const handler of api.handlers.get('before_agent_start') ?? []) {
      await handler(event as never, context);
    }

    return event.systemPromptOptions.appendSystemPrompt;
  } finally {
    vi.unstubAllEnvs();
  }
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

  const prompt = measuredPrompt(await workerHookPrompt(loadout, directory), directory);

  return { tools, size: prompt.length + toolsSize(tools), prompt };
};

const measureSessions = async (projectDirectory: string): Promise<Sessions> => {
  const measured: Sessions = new Map([
    ['lead', await roleSession('lead', projectDirectory)],
    ['architect', await roleSession('architect', projectDirectory)],
  ]);

  for (const name of profileNames) {
    measured.set(name, await workerSession(name, projectDirectory));
  }

  return measured;
};

const sessionsWithoutCoding = ['qa', 'browser', 'scout'];

const bundledSessions: Sessions = new Map();
const adoptedSessions: Sessions = new Map();
let directory = '';
let adoptedDirectory = '';

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'tau-prompt-budget-')));

  adoptedDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'tau-prompt-budget-adopted-')));

  await writeStommeProject(adoptedDirectory, { language: 'typescript', layers: ['pi'] });

  for (const [name, session] of await measureSessions(directory)) {
    bundledSessions.set(name, session);
  }

  for (const [name, session] of await measureSessions(adoptedDirectory)) {
    adoptedSessions.set(name, session);
  }
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(adoptedDirectory, { recursive: true, force: true });
});

const allTools = (): ToolDefinition[] => {
  const toolEntries = [...bundledSessions.values(), ...adoptedSessions.values()]
    .flatMap((session) => session.tools)
    .map((tool) => [tool.name, tool] as const);

  return [...new Map(toolEntries).values()];
};

describe('prompt budget', () => {
  it('a lead prompt holds the lead rules and no architect rules', () => {
    const prompt = bundledSessions.get('lead')?.prompt ?? '';
    const lead = managerGuidelines('lead', roleOptions);
    const architect = managerGuidelines('architect', roleOptions);
    const architectOnly = architect.filter((guideline) => !lead.includes(guideline));

    expect(lead.filter((guideline) => !prompt.includes(guideline))).toEqual([]);
    expect(architectOnly.filter((guideline) => prompt.includes(guideline))).toEqual([]);
  });

  it('an architect prompt holds the architect rules', () => {
    const prompt = bundledSessions.get('architect')?.prompt ?? '';
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

  it.each([
    ['an empty folder', bundledSessions],
    ['an adopted project', adoptedSessions],
  ])('keeps each session within its ceiling in %s', (_case, measured) => {
    const sessionCeilingNames = Object.keys(sessionCeilings).toSorted();
    expect([...measured.keys()].toSorted()).toEqual(sessionCeilingNames);

    const over = [...measured]
      .filter(([name, { size }]) => size > (sessionCeilings[name] ?? 0))
      .map(([name, { size }]) => `${name}: ${size} characters, ceiling ${sessionCeilings[name]}`);

    expect(over).toEqual([]);
  });

  it('measures a project heading the same for project roots of any length and place', () => {
    const heading = (root: string) =>
      `# Stomme 0.2.0 coding guides, from ${root}/docs/stomme/\n${checkoutDirectory}vendor/stomme`;

    const roots = ['/tmp/a', '/tmp/a-much-longer-project-folder-name', `${checkoutDirectory}tmp/p`];
    const nested = `${checkoutDirectory}tmp/a-much-longer-project-folder-name`;
    const measured = [...roots, nested].map((root) => measuredPrompt(heading(root), root));

    expect(new Set(measured).size).toBe(1);
  });

  it('measures a session without the coding set the same in both projects', () => {
    const sizes = (measured: Sessions) =>
      sessionsWithoutCoding.map((name) => [name, measured.get(name)?.size]);

    expect(sizes(adoptedSessions)).toEqual(sizes(bundledSessions));
  });
});
