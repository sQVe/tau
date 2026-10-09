import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

import { nestedChangeCallReason } from '../src/controlTools.js';
import {
  nativeIdentity,
  seedSession,
} from '../src/extensions/subagents/controller/nativeSession.js';
import { resolveProfile } from '../src/extensions/subagents/profiles.js';
import { publish, readEvent, validateTask } from '../src/extensions/subagents/records.js';
import workerExtension from '../src/extensions/subagents/workerExtension.js';
import { workerTools } from '../src/extensions/subagents/workerTools.js';
import workflowExtension, { codemodeGuidelines } from '../src/extensions/workflow.js';
import { skillTools } from '../src/skillTools.js';
import { createBoundSession } from './piSession.js';

interface ToolOutcome {
  toolName: string;
  isError: boolean;
  text: string;
}

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

const temporaryDirectory = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  return directory;
};

// Starts a worker session from a bundled profile, as a launched Pi worker would. A launched worker
// may run without Tau, so `workflow: false` leaves out the workflow extension.
const startProfileWorker = async (
  directory: string,
  profileName: string,
  { workflow = true }: { workflow?: boolean } = {},
) => {
  const taskDirectory = join(directory, 'task');
  mkdirSync(taskDirectory);
  vi.stubEnv('TAU_WORKER_RECORD', taskDirectory);
  const provider = fauxProvider({ provider: 'tau-profile-codemode' });
  const model = provider.getModel();
  const profile = resolveProfile(directory, directory, true, profileName);

  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }

  const task = validateTask({
    version: 7,
    taskId: `${profileName}-task`,
    task: 'Inspect source.txt.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent',
    ...nativeIdentity(taskDirectory),
    createdAt: Date.now(),
    deadline: Date.now() + 30_000,
    cancellationBudget: 2000,
    monotonicDeadline: Date.now() + 30_000,
    loadout: {
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
    },
  });

  publish(taskDirectory, 'task.json', task);
  seedSession(task);
  writeFileSync(join(directory, 'source.txt'), 'fixture-source');
  const executed: string[] = [];

  const extensionFactories = [
    createCodemodeExtension({ mode: 'on' }),
    packageToolFixtures(executed),
  ];

  if (workflow) {
    extensionFactories.push(workflowExtension);
  }

  extensionFactories.push(workerExtension);

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: workerTools(task.loadout, skillTools),
    sessionManager: SessionManager.open(task.nativeSessionFile),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionPaths: [safetyExtension],
    extensionFactories,
  });

  return { session, provider, taskDirectory, taskId: task.taskId, executed };
};

// Dispatches the task and waits until the worker's model follows `responses` to the end.
const runTask = async (
  worker: Awaited<ReturnType<typeof startProfileWorker>>,
  responses: FauxResponseStep[],
): Promise<ToolOutcome[]> => {
  const outcomes: ToolOutcome[] = [];
  const settled = Promise.withResolvers<undefined>();

  worker.session.subscribe((event) => {
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

  worker.provider.setResponses(responses);
  publish(worker.taskDirectory, 'dispatch.json', { taskId: worker.taskId });
  await settled.promise;

  return outcomes;
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

it.for([
  ['scout', true],
  ['reviewer', true],
  ['worker', true],
  ['qa', false],
  ['browser', false],
] as const)('gives the bundled %s profile codemode: %s', async ([profileName, expected]) => {
  const directory = temporaryDirectory('tau-profile-codemode-');
  const worker = await startProfileWorker(directory, profileName);

  expect(readEvent(worker.taskDirectory, worker.taskId, 'ready')).toBeDefined();
  expect(worker.session.getActiveToolNames().includes('codemode')).toBe(expected);
});

it('refuses a scout script call to a tool the profile does not list', async () => {
  const directory = temporaryDirectory('tau-scout-codemode-');
  const worker = await startProfileWorker(directory, 'scout');

  const script =
    "await tools.edit({ path: 'source.txt', edits: [{ oldText: 'fixture', newText: 'edited' }] });";

  const outcomes = await runTask(worker, [
    fauxAssistantMessage([fauxToolCall('codemode', { code: script })]),
    ...stopWithoutReport,
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(true);
  expect(result?.text).toContain('tools.edit does not exist');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('fixture-source');
});

it.for([
  ['scout', true],
  ['qa', false],
] as const)(
  'adds the codemode guidelines to the %s worker prompt: %s',
  async ([profileName, expected]) => {
    const directory = temporaryDirectory('tau-worker-guidelines-');
    const worker = await startProfileWorker(directory, profileName);
    const { captured, step } = captureSystemPrompt();

    await runTask(worker, [step, ...stopWithoutReport]);

    expect(captured.systemPrompt).toContain('# Tau workflow instructions');
    expect(hasCodemodeGuidelines(captured.systemPrompt)).toBe(expected);
  },
);

it.for([
  [['read', 'codemode'], true],
  [['read'], false],
] as const)(
  'adds the codemode guidelines to a manager prompt with tools %j: %s',
  async ([tools, expected]) => {
    const directory = temporaryDirectory('tau-manager-guidelines-');
    vi.stubEnv('TAU_WORKER_RECORD', '');
    const provider = fauxProvider({ provider: 'tau-manager-guidelines' });
    const { captured, step } = captureSystemPrompt();

    const { session } = await createBoundSession(onTestFinished, {
      cwd: directory,
      agentDirectory: directory,
      providers: [provider],
      tools: [...tools],
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      extensionFactories: [createCodemodeExtension({ mode: 'on' }), workflowExtension],
    });

    provider.setResponses([step]);
    await session.prompt('Check the fixture.');

    expect(captured.systemPrompt).toContain('# Tau workflow instructions');
    expect(hasCodemodeGuidelines(captured.systemPrompt)).toBe(expected);
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
  vi.stubEnv('TAU_WORKER_RECORD', '');
  writeFileSync(join(directory, 'source.txt'), 'fixture-source');
  const provider = fauxProvider({ provider: 'tau-manager-change-tools' });
  const executed: string[] = [];

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: ['read', 'write', 'edit', 'codemode', 'commit', 'run_tests'],
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionFactories: [
      createCodemodeExtension({ mode: 'on' }),
      packageToolFixtures(executed),
      workflowExtension,
    ],
  });

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
  const directory = temporaryDirectory('tau-worker-change-script-');
  const worker = await startProfileWorker(directory, 'worker', { workflow: false });

  const outcomes = await runTask(worker, [
    fauxAssistantMessage([fauxToolCall('codemode', { code: changeToolScript })]),
    ...stopWithoutReport,
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.text).toContain(nestedChangeCallReason);
  expect(result?.text).not.toContain('change-tool-ran');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('fixture-source');
  expect(worker.executed).toEqual([]);
});

it('runs change tools a worker calls directly', async () => {
  const directory = temporaryDirectory('tau-worker-change-direct-');
  const worker = await startProfileWorker(directory, 'worker', { workflow: false });

  const outcomes = await runTask(worker, [directChangeCalls, ...stopWithoutReport]);

  expect(outcomes.filter((outcome) => outcome.isError)).toEqual([]);
  expect(readFileSync(join(directory, 'written.txt'), 'utf8')).toBe('written');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('edited-source');
  expect(worker.executed.toSorted()).toEqual(['commit', 'run_tests']);
});

it('refuses change tools called from a manager script and changes nothing', async () => {
  const directory = temporaryDirectory('tau-manager-change-script-');
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
  const directory = temporaryDirectory('tau-manager-change-direct-');
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
  const directory = temporaryDirectory('tau-worker-budget-refusal-');
  const worker = await startProfileWorker(directory, 'scout');

  const outcomes = await runTask(worker, [
    fauxAssistantMessage([fauxToolCall('codemode', { code: raisedWithoutReason })]),
    ...stopWithoutReport,
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(true);
  expect(result?.text).toContain('// @budget: <reason>');
  expect(result?.text).not.toContain('budget-script-ran');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('fixture-source');
  expect(worker.executed).toEqual([]);
});

it('returns the items that fit and names each cut item with the full-output path', async () => {
  const directory = temporaryDirectory('tau-worker-budget-cut-');
  const worker = await startProfileWorker(directory, 'scout');

  const outcomes = await runTask(worker, [
    fauxAssistantMessage([
      fauxToolCall('codemode', {
        code: `// @options: {"max_output_tokens": 2000}\n${overBudgetScript}`,
      }),
    ]),
    ...stopWithoutReport,
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');
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
  const directory = temporaryDirectory('tau-worker-budget-within-');
  const worker = await startProfileWorker(directory, 'scout');

  const outcomes = await runTask(worker, [
    fauxAssistantMessage([fauxToolCall('codemode', { code: withinBudgetScript })]),
    ...stopWithoutReport,
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(false);
  expect(result?.text).toContain('small one');
  expect(result?.text).toContain('small two');
  expect(result?.text).not.toContain('Output over the budget');
  expect(result?.text).not.toContain('Warning: truncated output');
});

it('blocks a manager script that raises the budget without a reason', async () => {
  const directory = temporaryDirectory('tau-manager-budget-refusal-');
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
  const directory = temporaryDirectory('tau-worker-budget-rows-');
  const worker = await startProfileWorker(directory, 'scout');
  const script = "for (let row = 1; row <= 1000; row++) text('row ' + row + ' ' + 'x'.repeat(40));";

  const outcomes = await runTask(worker, [
    fauxAssistantMessage([fauxToolCall('codemode', { code: script })]),
    ...stopWithoutReport,
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');
  const content = (JSON.parse(result?.text ?? '{}') as { content: { text: string }[] }).content;
  const bodyLength = content.slice(1).reduce((sum, item) => sum + item.text.length, 0);

  expect(result?.isError).toBe(false);
  expect(bodyLength).toBeLessThanOrEqual(16_000);
  expect(content.at(-1)?.text).toContain('-1000');
});

it('lets Pi reject an invalid max_output_tokens and runs no nested call', async () => {
  const directory = temporaryDirectory('tau-worker-budget-invalid-');
  const worker = await startProfileWorker(directory, 'scout');
  const script = `// @options: {"max_output_tokens": -1}\nawait tools.read({ path: 'source.txt' });\ntext('invalid-ran');`;

  const outcomes = await runTask(worker, [
    fauxAssistantMessage([fauxToolCall('codemode', { code: script })]),
    ...stopWithoutReport,
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(true);
  expect(result?.text).toContain('max_output_tokens');
  expect(result?.text).not.toContain('invalid-ran');
});
