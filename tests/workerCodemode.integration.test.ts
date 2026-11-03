import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import type { FauxResponseStep } from '@earendil-works/pi-ai';
import { SessionManager, createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expect, it, onTestFinished, vi } from 'vitest';

import { nestedChangeCallReason } from '../src/codemode/controlTools.js';
import { codemodeGuidelines } from '../src/codemode/guidelines.js';
import codemodeExtension from '../src/extensions/codemode.js';
import fullCheckExtension from '../src/extensions/fullCheck/fullCheck.js';
import instructionsExtension from '../src/extensions/instructions.js';
import {
  assignmentDirectory,
  assignmentPath,
  writeAssignment,
} from '../src/extensions/subagents/assignment.js';
import type { Assignment } from '../src/extensions/subagents/assignment.js';
import { resolveProfile } from '../src/extensions/subagents/profiles.js';
import workerExtension from '../src/extensions/subagents/workerExtension.js';
import { workerTools } from '../src/extensions/subagents/workerTools.js';
import { skillTools } from '../src/skillTools.js';
import { createHcFake } from './hcFake.js';
import { createPiSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface ToolOutcome {
  toolName: string;
  isError: boolean;
  text: string;
}

const workerTerminal = 'worker';

const safetyExtension = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

// Bundled profiles name tools from other packages. Workers refuse to start without them.
const packageTools = [
  'web_search',
  'fetch_content',
  'get_search_content',
  'run_tests',
  'commit',
  'agent_browser',
  'agent_browser_code',
];

// Records each package tool that runs in `executed`.
const packageToolFixtures = (executed: string[]) => (pi: ExtensionAPI) => {
  for (const name of packageTools) {
    pi.registerTool({
      name,
      label: name,
      description: `Fixture ${name}.`,
      parameters: Type.Object({}),
      execute: () => {
        executed.push(name);

        return Promise.resolve({ content: [{ type: 'text', text: name }], details: {} });
      },
    });
  }
};

const piAgentDirectory = (prefix: string): string => {
  const directory = temporaryDirectory(onTestFinished, prefix);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  return directory;
};

const seedAssignment = async (
  directory: string,
  profileName: string,
  loadout: Assignment['loadout'],
): Promise<{ path: string; sessionFile: string }> => {
  const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const path = assignmentPath(assignmentId);
  const sessionFile = join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`);

  await writeAssignment({
    version: 1,
    assignmentId,
    task: 'Inspect source.txt.',
    acceptance: [],
    label: null,
    profile: profileName,
    loadout,
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: sessionFile },
    parentSession: join(directory, 'parent.jsonl'),
    cwd: directory,
    parentTerminal: 'manager',
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    report: null,
  });

  return { path, sessionFile };
};

const startProfileWorker = async (
  directory: string,
  profileName: string,
  responses: FauxResponseStep[],
  { workflow = true }: { workflow?: boolean } = {},
) => {
  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);
  const provider = fauxProvider({ provider: 'tau-profile-codemode' });
  const model = provider.getModel();
  const profile = resolveProfile(directory, directory, true, profileName);

  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }

  const loadout: Assignment['loadout'] = {
    harness: 'pi',
    profile: profileName,
    role: profile.role,
    model: `${model.provider}/${model.id}`,
    thinking: 'off',
    cwd: directory,
    agentDirectory: directory,
    permissions: 'trusted-full-tools',
    instructions: profile.instructions,
    tools: profile.tools,
    skills: [],
    instructionSets: profile.instructionSets,
    packages: [],
  };

  const { path, sessionFile } = await seedAssignment(directory, profileName, loadout);

  const hc = createHcFake();

  hc.reply(
    'get',
    JSON.stringify({
      address: workerTerminal,
      state: 'live',
      parent: 'manager',
      labels: { 'tau.assignment': path },
    }),
  );

  writeFileSync(join(directory, 'source.txt'), 'fixture-source');
  const executed: string[] = [];

  const extensionFactories = [
    createCodemodeExtension({ mode: 'on' }),
    packageToolFixtures(executed),
    fullCheckExtension,
  ];

  if (workflow) {
    extensionFactories.push(instructionsExtension, codemodeExtension);
  }

  const created = await createPiSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: workerTools(loadout, skillTools),
    sessionManager: SessionManager.open(sessionFile),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionPaths: [safetyExtension],
    extensionFactories: [
      ...extensionFactories,
      (pi) => {
        pi.exec = hc.exec;

        workerExtension(pi);
      },
    ],
  });

  if (created.extensionsResult.errors.length > 0) {
    throw new Error(
      `Extensions failed to load: ${JSON.stringify(created.extensionsResult.errors)}`,
    );
  }

  const outcomes: ToolOutcome[] = [];
  const settled = Promise.withResolvers<undefined>();

  created.session.subscribe((event) => {
    if (event.type === 'tool_execution_end') {
      outcomes.push({
        toolName: event.toolName,
        isError: event.isError,
        text: JSON.stringify(event.result),
      });
    }

    if (event.type === 'agent_settled') {
      settled.resolve(undefined);
    }
  });

  provider.setResponses(responses);
  await created.session.bindExtensions({});
  await settled.promise;

  return { executed, outcomes, path, session: created.session };
};

const stopWithoutReport = [
  fauxAssistantMessage('Stopping without a report.'),
  fauxAssistantMessage('Stopping without a report.'),
];

// Answers the first turn with a text reply and returns the system prompt that turn used.
const captureSystemPrompt = () => {
  const captured: { systemPrompt?: string } = {};

  const step: FauxResponseStep = (context) => {
    captured.systemPrompt = getCurrentSystemPrompt(context.messages);

    return fauxAssistantMessage('Stopping without a report.');
  };

  return { captured, step };
};

const hasCodemodeGuidelines = (systemPrompt: string | undefined): boolean =>
  codemodeGuidelines.every((guideline) => systemPrompt?.includes(guideline) === true);

const guidelineLineCounts = (systemPrompt: string | undefined, guidelines: readonly string[]) => {
  const lines = (systemPrompt ?? '').split('\n');

  return guidelines.map((guideline) => lines.filter((line) => line === `- ${guideline}`).length);
};

it.for([
  ['scout', true],
  ['reviewer', true],
  ['checker', true],
  ['worker', true],
  ['qa', false],
  ['browser', false],
] as const)('gives the bundled %s profile codemode: %s', async ([profileName, expected]) => {
  const directory = piAgentDirectory('tau-profile-codemode-');
  const worker = await startProfileWorker(directory, profileName, stopWithoutReport);

  expect(worker.session.getActiveToolNames().includes('codemode')).toBe(expected);
});

it('refuses a scout script call to a tool the profile does not list', async () => {
  const directory = piAgentDirectory('tau-scout-codemode-');

  const worker = await startProfileWorker(directory, 'scout', [
    fauxAssistantMessage([
      fauxToolCall('codemode', {
        code: "await tools.edit({ path: 'source.txt', edits: [{ oldText: 'fixture', newText: 'edited' }] });",
      }),
    ]),
    ...stopWithoutReport,
  ]);

  const result = worker.outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(true);
  expect(result?.text).toContain('tools.edit does not exist');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('fixture-source');
});

it.for([
  ['scout', true, true],
  ['scout', false, true],
  ['worker', true, true],
  ['worker', false, true],
  ['qa', true, false],
  ['qa', false, false],
] as const)(
  'adds the codemode guidelines to the %s worker prompt with workflow %s: %s',
  async ([profileName, workflow, expected]) => {
    const directory = piAgentDirectory('tau-worker-guidelines-');
    const { captured, step } = captureSystemPrompt();

    await startProfileWorker(directory, profileName, [step, ...stopWithoutReport], { workflow });

    expect(captured.systemPrompt).toContain('# Tau workflow instructions');
    expect(hasCodemodeGuidelines(captured.systemPrompt)).toBe(expected);

    expect(guidelineLineCounts(captured.systemPrompt, codemodeGuidelines)).toEqual(
      codemodeGuidelines.map(() => (expected ? 1 : 0)),
    );

    expect(captured.systemPrompt).not.toContain('Launch independent workers');
  },
);

it.for([
  [['read', 'codemode'], true],
  [['read'], false],
] as const)(
  'adds the codemode guidelines to a manager prompt with tools %j: %s',
  async ([tools, expected]) => {
    const directory = piAgentDirectory('tau-manager-guidelines-');
    vi.stubEnv('TAU_ROLE', '');
    const provider = fauxProvider({ provider: 'tau-manager-guidelines' });
    const { captured, step } = captureSystemPrompt();

    const { session } = await createPiSession(onTestFinished, {
      cwd: directory,
      agentDirectory: directory,
      providers: [provider],
      tools: [...tools],
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      extensionFactories: [
        createCodemodeExtension({ mode: 'on' }),
        instructionsExtension,
        codemodeExtension,
      ],
    });

    provider.setResponses([step]);
    await session.bindExtensions({});
    await session.prompt('Check the fixture.');

    expect(captured.systemPrompt).toContain('# Tau workflow instructions');
    expect(hasCodemodeGuidelines(captured.systemPrompt)).toBe(expected);

    expect(guidelineLineCounts(captured.systemPrompt, codemodeGuidelines)).toEqual(
      codemodeGuidelines.map(() => (expected ? 1 : 0)),
    );
  },
);

// Calls each change tool from one script and prints each refusal or result.
const changeToolScript = `
const calls = [
  () => tools.write({ path: 'source.txt', content: 'written' }),
  () => tools.edit({ path: 'source.txt', edits: [{ oldText: 'fixture', newText: 'edited' }] }),
  () => tools.commit({}),
  () => tools.run_tests({}),
];
for (const call of calls) {
  try {
    await call();
    text('change-tool-ran');
  } catch (error) {
    text(error.message);
  }
}
`;

const directChangeCalls = fauxAssistantMessage([
  fauxToolCall('write', { path: 'written.txt', content: 'written' }),
  fauxToolCall('edit', { path: 'source.txt', edits: [{ oldText: 'fixture', newText: 'edited' }] }),
  fauxToolCall('commit', {}),
  fauxToolCall('run_tests', {}),
]);

// Starts a manager session with codemode, the built-in change tools, and package tool fixtures.
const startManager = async (directory: string) => {
  vi.stubEnv('TAU_ROLE', '');
  writeFileSync(join(directory, 'source.txt'), 'fixture-source');
  const provider = fauxProvider({ provider: 'tau-manager-change-tools' });
  const executed: string[] = [];

  const { session } = await createPiSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: ['read', 'write', 'edit', 'codemode', 'commit', 'run_tests'],
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionFactories: [
      createCodemodeExtension({ mode: 'on' }),
      packageToolFixtures(executed),
      instructionsExtension,
      codemodeExtension,
    ],
  });

  await session.bindExtensions({});

  const run = async (responses: FauxResponseStep[]): Promise<ToolOutcome[]> => {
    const outcomes: ToolOutcome[] = [];

    session.subscribe((event) => {
      if (event.type === 'tool_execution_end') {
        outcomes.push({
          toolName: event.toolName,
          isError: event.isError,
          text: JSON.stringify(event.result),
        });
      }
    });

    provider.setResponses(responses);
    await session.prompt('Change the fixture.');

    return outcomes;
  };

  return { run, executed };
};

it('refuses change tools called from a worker script and changes nothing', async () => {
  const directory = piAgentDirectory('tau-worker-change-script-');

  const worker = await startProfileWorker(
    directory,
    'worker',
    [
      fauxAssistantMessage([fauxToolCall('codemode', { code: changeToolScript })]),
      ...stopWithoutReport,
    ],
    { workflow: false },
  );

  const result = worker.outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.text).toContain(nestedChangeCallReason);
  expect(result?.text).not.toContain('change-tool-ran');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('fixture-source');
  expect(worker.executed).toEqual([]);
});

it('runs change tools a worker calls directly', async () => {
  const directory = piAgentDirectory('tau-worker-change-direct-');

  const worker = await startProfileWorker(
    directory,
    'worker',
    [directChangeCalls, ...stopWithoutReport],
    {
      workflow: false,
    },
  );

  expect(worker.outcomes.filter((outcome) => outcome.isError)).toEqual([]);
  expect(readFileSync(join(directory, 'written.txt'), 'utf8')).toBe('written');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('edited-source');
  expect(worker.executed.toSorted()).toEqual(['commit', 'run_tests']);
});

it('refuses change tools called from a manager script and changes nothing', async () => {
  const directory = piAgentDirectory('tau-manager-change-script-');
  const manager = await startManager(directory);

  const outcomes = await manager.run([
    fauxAssistantMessage([fauxToolCall('codemode', { code: changeToolScript })]),
    fauxAssistantMessage('Done.'),
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.text).toContain(nestedChangeCallReason);
  expect(result?.text).not.toContain('change-tool-ran');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('fixture-source');
  expect(manager.executed).toEqual([]);
});

it('runs change tools a manager calls directly', async () => {
  const directory = piAgentDirectory('tau-manager-change-direct-');
  const manager = await startManager(directory);

  const outcomes = await manager.run([directChangeCalls, fauxAssistantMessage('Done.')]);

  expect(outcomes.filter((outcome) => outcome.isError)).toEqual([]);
  expect(readFileSync(join(directory, 'written.txt'), 'utf8')).toBe('written');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('edited-source');
  expect(manager.executed.toSorted()).toEqual(['commit', 'run_tests']);
});

const raisedWithoutReason = `// @options: {"max_output_tokens": 8000}
await tools.read({ path: 'source.txt' });
text('budget-script-ran');
`;

// Prints three items of about 3,000 characters. With a budget of 2,000 tokens, only the first fits
// beside the room Tau keeps for the list of cut items.
const overBudgetScript = `
text('first-item-start ' + 'a'.repeat(3000));
text('second-item-start ' + 'b'.repeat(3000));
text('third-item-start ' + 'c'.repeat(3000));
`;

const withinBudgetScript = `
text('small one');
text('small two');
`;

it('blocks a worker script that raises the budget without a reason and runs nothing', async () => {
  const directory = piAgentDirectory('tau-worker-budget-refusal-');

  const worker = await startProfileWorker(directory, 'scout', [
    fauxAssistantMessage([fauxToolCall('codemode', { code: raisedWithoutReason })]),
    ...stopWithoutReport,
  ]);

  const result = worker.outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(true);
  expect(result?.text).toContain('// @budget: <reason>');
  expect(result?.text).not.toContain('budget-script-ran');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('fixture-source');
  expect(worker.executed).toEqual([]);
});

it('returns the items that fit and names each cut item with the full-output path', async () => {
  const directory = piAgentDirectory('tau-worker-budget-cut-');

  const worker = await startProfileWorker(directory, 'scout', [
    fauxAssistantMessage([
      fauxToolCall('codemode', {
        code: `// @options: {"max_output_tokens": 2000}\n${overBudgetScript}`,
      }),
    ]),
    ...stopWithoutReport,
  ]);

  const result = worker.outcomes.find((outcome) => outcome.toolName === 'codemode');
  const path = /Full output: ([^\s\]\\]+)/.exec(result?.text ?? '')?.[1];

  expect(result?.isError).toBe(false);
  expect(result?.text).toContain('a'.repeat(3000));
  expect(result?.text).not.toContain('item 1:');
  expect(result?.text).not.toContain('b'.repeat(200));
  expect(result?.text).toContain('item 2: \\"second-item-start');
  expect(result?.text).toContain('item 3: \\"third-item-start');
  expect(path).toBeDefined();
  expect(readFileSync(path ?? '', 'utf8')).toContain('third-item-start');
});

it('returns a script within its budget as Pi does without the budget handlers', async () => {
  const directory = piAgentDirectory('tau-worker-budget-within-');

  const worker = await startProfileWorker(directory, 'scout', [
    fauxAssistantMessage([fauxToolCall('codemode', { code: withinBudgetScript })]),
    ...stopWithoutReport,
  ]);

  const result = worker.outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(false);
  expect(result?.text).toContain('small one');
  expect(result?.text).toContain('small two');
  expect(result?.text).not.toContain('Output over the budget');
  expect(result?.text).not.toContain('Warning: truncated output');
});

it('blocks a manager script that raises the budget without a reason', async () => {
  const directory = piAgentDirectory('tau-manager-budget-refusal-');
  const manager = await startManager(directory);

  const outcomes = await manager.run([
    fauxAssistantMessage([fauxToolCall('codemode', { code: raisedWithoutReason })]),
    fauxAssistantMessage('Done.'),
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(true);
  expect(result?.text).toContain('// @budget: <reason>');
  expect(result?.text).not.toContain('budget-script-ran');
});

it('keeps a script with 1,000 short rows within the default budget', async () => {
  const directory = piAgentDirectory('tau-worker-budget-rows-');
  const script = "for (let row = 1; row <= 1000; row++) text('row ' + row + ' ' + 'x'.repeat(40));";

  const worker = await startProfileWorker(directory, 'scout', [
    fauxAssistantMessage([fauxToolCall('codemode', { code: script })]),
    ...stopWithoutReport,
  ]);

  const result = worker.outcomes.find((outcome) => outcome.toolName === 'codemode');
  const content = (JSON.parse(result?.text ?? '{}') as { content: { text: string }[] }).content;
  const bodyLength = content.slice(1).reduce((sum, item) => sum + item.text.length, 0);

  expect(result?.isError).toBe(false);
  expect(bodyLength).toBeLessThanOrEqual(16_000);
  expect(content.at(-1)?.text).toContain('-1000');
});

it('lets Pi reject an invalid max_output_tokens and runs no nested call', async () => {
  const directory = piAgentDirectory('tau-worker-budget-invalid-');
  const script = `// @options: {"max_output_tokens": -1}\nawait tools.read({ path: 'source.txt' });\ntext('invalid-ran');`;

  const worker = await startProfileWorker(directory, 'scout', [
    fauxAssistantMessage([fauxToolCall('codemode', { code: script })]),
    ...stopWithoutReport,
  ]);

  const result = worker.outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(true);
  expect(result?.text).toContain('max_output_tokens');
  expect(result?.text).not.toContain('invalid-ran');
});
