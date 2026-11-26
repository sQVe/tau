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

interface Session {
  tools: ToolDefinition[];
  size: number;
  prompt: string;
}

type Sessions = Map<string, Session>;

const oneActionBudget = 1000;
const multiActionBudget = 3000;

// Tools over budget today, each with its current description length as its own ceiling.
const descriptionExceptions: Readonly<Record<string, number>> = {};

// Each ceiling caps a session at its larger measured size, the empty folder or the adopted project.
// The test rejects only growth, so lower a ceiling by hand after a cut. The target is beside each
// ceiling. CI measures the pull request merged into its base branch, so a ceiling must also cover the
// prompt text the base branch adds after the branch's last merge; measure that merge before lowering
// one. That is why a local reading can sit below its ceiling.
const sessionCeilings: Readonly<Record<string, number>> = {
  // The adopted-project reading is 70,713. The ceiling adds 124 characters so a small base-branch
  // prompt change does not fail the merge; measure the merge again before lowering it.
  lead: 70_837, // target 38,000
  // The adopted-project reading is 64,376. The ceiling adds 124 characters so a small base-branch
  // prompt change does not fail the merge; measure the merge again before lowering it.
  architect: 64_500,
  worker: 29_356, // target 14,000
  reviewer: 24_635, // target 11,000
  checker: 24_788,
  qa: 19_173, // measured locally; target 9,000
  browser: 16_797, // target 9,000
  scout: 16_356, // target 9,000
};

const profileNames = ['worker', 'reviewer', 'checker', 'qa', 'browser', 'scout'];
const workerTerminal = 'worker-1';
const parentTerminal = 'manager-1';
const skillsDirectory = fileURLToPath(new URL('../src/skills/', import.meta.url));
const checkoutDirectory = fileURLToPath(new URL('../', import.meta.url));

// The worker command loads these from Pi, a package, or a separate extension, so this test's
// registration fake does not provide them.
const providedToolNames = [
  'read',
  'bash',
  'edit',
  'write',
  'codemode',
  'verification_record',
  'agent_browser',
  'agent_browser_code',
  'web_search',
  'fetch_content',
  'get_search_content',
];

// A bundled guide's source line names its absolute path, and an adopted project's heading names the
// project root, so fixed tokens stand in for both. Otherwise the measured size would depend on where
// Tau is checked out and on the temporary folder of the host.
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const replacePath = (text: string, path: string, token: string): string => {
  const boundary = path.endsWith('/') ? '' : '(?=/|$)';
  const pattern = new RegExp(`${escapeRegExp(path)}${boundary}`, 'g');

  return text.replaceAll(pattern, token);
};

const measuredPrompt = (prompt: string, projectDirectory: string): string =>
  replacePath(replacePath(prompt, projectDirectory, '<project>'), checkoutDirectory, '<tau>/');

const isMultiAction = (tool: ToolDefinition): boolean =>
  Object.hasOwn((tool.parameters as { properties?: object }).properties ?? {}, 'action');

const toolSize = (tool: ToolDefinition): number =>
  tool.description.length + JSON.stringify(tool.parameters).length;

const toolsSize = (tools: ToolDefinition[]): number =>
  tools.reduce((total, tool) => total + toolSize(tool), 0);

const stubRoleEnvironment = (role: RoleKind, agentDirectory: string): void => {
  const tauRole = role === 'lead' ? undefined : role;
  const workerRecord = role === 'worker' ? 'worker-record' : '';
  const terminalId = role === 'worker' ? workerTerminal : 'manager';

  vi.stubEnv('TAU_ROLE', tauRole);
  vi.stubEnv('TAU_WORKER_RECORD', workerRecord);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', terminalId);
  // A caller's handover sender must not register its lead-only tool in a measurement.
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');
};

const withRoleEnvironment = async <T>(
  role: RoleKind,
  agentDirectory: string,
  action: () => Promise<T>,
): Promise<T> => {
  stubRoleEnvironment(role, agentDirectory);

  try {
    return await action();
  } finally {
    vi.unstubAllEnvs();
  }
};

const withRegisteredSession = async <T>(
  role: RoleKind,
  agentDirectory: string,
  action: (fake: ReturnType<typeof fakeExtensionApi>) => Promise<T>,
  registerExtensions: (pi: ExtensionAPI) => Promise<void> = tauRegistration,
): Promise<T> =>
  withRoleEnvironment(role, agentDirectory, async () => {
    const fake = fakeExtensionApi();

    await registerExtensions(fake.pi);

    return action(fake);
  });

const loadTools = async (
  role: RoleKind,
  agentDirectory: string,
  registerExtensions: (pi: ExtensionAPI) => Promise<void> = tauRegistration,
) =>
  withRegisteredSession(
    role,
    agentDirectory,
    async (fake) => {
      if (role === 'worker') {
        workerExtension(fake.pi);
      }

      return fake;
    },
    registerExtensions,
  );

const failRegistration = async (): Promise<void> => {
  throw new Error('registration failed');
};

const roleOptions = {
  loginCommand: undefined,
  qaProcedurePath: undefined,
  qaGuidePath,
};

const roleSession = async (role: 'lead' | 'architect', agentDirectory: string) =>
  withRegisteredSession(role, agentDirectory, async (fake) => {
    const event = {
      systemPromptOptions: { appendSystemPrompt: '', selectedTools: [...fake.tools.keys()] },
    };

    for (const handler of fake.handlers.get('before_agent_start') ?? []) {
      await handler(
        event as never,
        {
          cwd: agentDirectory,
          sessionManager: { getBranch: () => [], getSessionId: () => 'session-1' },
        } as unknown as ExtensionContext,
      );
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
  });

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

const assignmentFor = (loadout: Loadout, directory: string): Assignment => {
  const assignmentId = randomUUID();
  const sessionId = randomUUID();

  return {
    version: 4,
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
    fullCheck: null,
  };
};

const workerHookPrompt = async (
  loadout: Loadout,
  directory: string,
  registeredToolNames: string[],
  extraActiveTool?: string,
): Promise<{ activeTools: string[]; prompt: string }> => {
  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);

  try {
    const assignment = assignmentFor(loadout, directory);
    const hc = createHcFake();
    const setActiveTools = vi.fn<ExtensionAPI['setActiveTools']>();

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
      getAllTools: () =>
        [...new Set([...registeredToolNames, ...providedToolNames])].map((name) => ({ name })),
      setActiveTools: (names: string[]) => {
        const active = extraActiveTool === undefined ? names : [...names, extraActiveTool];
        setActiveTools(active);
      },
    } as unknown as Partial<ExtensionAPI>);

    const context = {
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => assignment.session.id,
      },
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

    return {
      activeTools: setActiveTools.mock.calls.at(-1)?.[0] ?? [],
      prompt: event.systemPromptOptions.appendSystemPrompt,
    };
  } finally {
    vi.unstubAllEnvs();
  }
};

const workerSession = async (profileName: string, directory: string, extraActiveTool?: string) => {
  const fake = await loadTools('worker', directory);
  const loadout = loadoutFor(profileName, directory);
  const expectedNames = workerTools(loadout, skillTools);
  const expected = new Set(expectedNames);

  const tauTools = workerTools(
    { tools: [], skills: loadout.skills, role: loadout.role },
    skillTools,
  );

  const missing = tauTools.filter((name) => !fake.tools.has(name));

  if (missing.length > 0) {
    throw new Error(`${profileName} worker does not register: ${missing.join(', ')}`);
  }

  const { activeTools, prompt: hookPrompt } = await workerHookPrompt(
    loadout,
    directory,
    [...fake.tools.keys()],
    extraActiveTool,
  );

  const unexpected = activeTools.filter((name) => !expected.has(name));

  if (unexpected.length > 0) {
    throw new Error(`${profileName} worker activated unexpected tools: ${unexpected.join(', ')}`);
  }

  const inactive = expectedNames.filter((name) => !activeTools.includes(name));

  if (inactive.length > 0) {
    throw new Error(`${profileName} worker did not activate: ${inactive.join(', ')}`);
  }

  const active = new Set(activeTools);
  const tools = [...fake.tools.values()].filter((tool) => active.has(tool.name));

  const prompt = measuredPrompt(hookPrompt, directory);

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

const senderBranch = [
  {
    type: 'message',
    message: {
      role: 'user',
      content:
        'Handover sender: terminal lead-1, session 33333333-3333-4333-8333-333333333333.\n\nDo the work.',
    },
  },
];

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

const allTools = (
  sessions: Session[] = [...bundledSessions.values(), ...adoptedSessions.values()],
): ToolDefinition[] => sessions.flatMap((session) => session.tools);

const fixtureTool = (name: string, description: string): ToolDefinition =>
  ({
    name,
    description,
    parameters: { type: 'object', properties: {} },
  }) as unknown as ToolDefinition;

const fixtureSession = (tools: ToolDefinition[]): Session => ({ tools, size: 0, prompt: '' });

const overBudgetDescriptions = (tools: ToolDefinition[]): string[] =>
  tools
    .filter((tool) => !Object.hasOwn(descriptionExceptions, tool.name))
    .map((tool) => ({
      name: tool.name,
      length: tool.description.length,
      budget: isMultiAction(tool) ? multiActionBudget : oneActionBudget,
    }))
    .filter(({ length, budget }) => length > budget)
    .map(({ name, length, budget }) => `${name}: ${length} characters, budget ${budget}`);

const exceptedDescriptionOverruns = (
  tools: ToolDefinition[],
  exceptions: Readonly<Record<string, number>> = descriptionExceptions,
): string[] => {
  const over: string[] = [];

  for (const [name, ceiling] of Object.entries(exceptions)) {
    const matching = tools.filter((tool) => tool.name === name);

    if (matching.length === 0) {
      over.push(`${name}: not registered characters, ceiling ${ceiling}`);

      continue;
    }

    for (const tool of matching) {
      const length = tool.description.length;

      if (length > ceiling) {
        over.push(`${name}: ${length} characters, ceiling ${ceiling}`);
      }
    }
  }

  return over;
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
    expect(overBudgetDescriptions(allTools())).toEqual([]);
  });

  it('checks every definition of a tool name against its description budget', () => {
    const overBudget = fixtureTool('shared', 'x'.repeat(oneActionBudget + 1));
    const withinBudget = fixtureTool('shared', 'x');

    const orderings = [
      [fixtureSession([overBudget, withinBudget])],
      [fixtureSession([withinBudget, overBudget])],
    ];

    expect(orderings.map((sessions) => overBudgetDescriptions(allTools(sessions)))).toEqual([
      ['shared: 1001 characters, budget 1000'],
      ['shared: 1001 characters, budget 1000'],
    ]);
  });

  it('keeps the question tool within its budget for a lead with a handover sender', async () => {
    const questionTool = await withRegisteredSession('lead', directory, async (fake) => {
      const context = {
        cwd: directory,
        sessionManager: {
          getBranch: () => senderBranch,
          getSessionId: () => 'session-1',
        },
      } as unknown as ExtensionContext;

      const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools: [] } };

      for (const handler of fake.handlers.get('before_agent_start') ?? []) {
        await handler(event as never, context);
      }

      return fake.tools.get('handover_question');
    });

    expect(questionTool).toBeDefined();

    if (questionTool === undefined) {
      return;
    }

    expect(questionTool.description.length).toBeLessThanOrEqual(oneActionBudget);
  });

  it('keeps each excepted tool within its recorded length', () => {
    expect(exceptedDescriptionOverruns(allTools())).toEqual([]);
  });

  it('checks every definition of an excepted tool name against its ceiling', () => {
    const overCeiling = fixtureTool('shared', 'xx');
    const withinCeiling = fixtureTool('shared', 'x');

    const orderings = [
      [fixtureSession([overCeiling, withinCeiling])],
      [fixtureSession([withinCeiling, overCeiling])],
    ];

    expect(
      orderings.map((sessions) => exceptedDescriptionOverruns(allTools(sessions), { shared: 1 })),
    ).toEqual([['shared: 2 characters, ceiling 1'], ['shared: 2 characters, ceiling 1']]);
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

  it('normalizes a nested project without rewriting a sibling with its shared prefix', () => {
    const project = `${checkoutDirectory}tmp/project`;
    const sibling = `${project}-other`;
    const prompt = `from ${project}/docs, ${sibling}/docs, ${checkoutDirectory}vendor`;

    expect(measuredPrompt(prompt, project)).toBe(
      'from <project>/docs, <tau>/tmp/project-other/docs, <tau>/vendor',
    );
  });

  it('stubs the terminal ID for manager and worker registrations', async () => {
    const seen: (string | undefined)[] = [];

    const recordTerminal = async (): Promise<void> => {
      seen.push(process.env.HC_TERMINAL_ID);
    };

    await loadTools('lead', directory, recordTerminal);
    await loadTools('worker', directory, recordTerminal);

    expect(seen).toEqual(['manager', workerTerminal]);
  });

  it('fails a worker session that activates a tool outside its allowlist', async () => {
    await expect(workerSession('worker', directory, 'extra_tool')).rejects.toThrow(
      'activated unexpected tools: extra_tool',
    );
  });

  it('measures a session without the coding set the same in both projects', () => {
    const sizes = (measured: Sessions) =>
      sessionsWithoutCoding.map((name) => [name, measured.get(name)?.size]);

    expect(sizes(adoptedSessions)).toEqual(sizes(bundledSessions));
  });

  it('restores the environment when extension registration throws', async () => {
    const before = {
      HC_TERMINAL_ID: process.env.HC_TERMINAL_ID,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      TAU_ROLE: process.env.TAU_ROLE,
      TAU_WORKER_RECORD: process.env.TAU_WORKER_RECORD,
      TAU_HANDOVER_SENDER_TERMINAL: process.env.TAU_HANDOVER_SENDER_TERMINAL,
      TAU_HANDOVER_SENDER_SESSION: process.env.TAU_HANDOVER_SENDER_SESSION,
    };

    await expect(loadTools('worker', directory, failRegistration)).rejects.toThrow(
      'registration failed',
    );

    expect({
      HC_TERMINAL_ID: process.env.HC_TERMINAL_ID,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      TAU_ROLE: process.env.TAU_ROLE,
      TAU_WORKER_RECORD: process.env.TAU_WORKER_RECORD,
      TAU_HANDOVER_SENDER_TERMINAL: process.env.TAU_HANDOVER_SENDER_TERMINAL,
      TAU_HANDOVER_SENDER_SESSION: process.env.TAU_HANDOVER_SENDER_SESSION,
    }).toEqual(before);
  });
});
