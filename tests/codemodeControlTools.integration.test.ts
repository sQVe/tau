import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { FauxResponseStep } from '@earendil-works/pi-ai';
import { SessionManager, createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import askUserQuestionExtension from '../src/extensions/askUserQuestion/askUserQuestion.js';
import {
  assignmentDirectory,
  assignmentPath,
  readAssignment,
  writeAssignment,
} from '../src/extensions/subagents/assignment.js';
import type { Assignment } from '../src/extensions/subagents/assignment.js';
import subagentsExtension, {
  registerCapacityRefusal,
} from '../src/extensions/subagents/subagents.js';
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

const managerTools = ['subagent'];

const workerControlTools = new Set(['subagent_report', 'ask_user_question']);

const managerControlTools = new Set(['subagent', 'ask_user_question']);

const safetyExtension = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

// A script's `return` value is the last text block of the codemode result, as JSON.
const scriptValue = (outcomes: ToolOutcome[]): unknown => {
  const script = outcomes.find((outcome) => outcome.toolName === 'codemode');

  if (!script || script.isError) {
    throw new Error(`Script did not complete: ${script?.text ?? 'no codemode call'}`);
  }

  const result = JSON.parse(script.text) as { content: { type: string; text?: string }[] };
  const output = result.content.findLast((block) => block.type === 'text')?.text ?? '';

  return JSON.parse(output);
};

const handover = 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None';

const codemodeCall = (code: string) => fauxAssistantMessage([fauxToolCall('codemode', { code })]);

const runWorker = async (responses: FauxResponseStep[]) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-codemode-worker-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);
  const provider = fauxProvider({ provider: 'tau-codemode-fixture' });
  const model = provider.getModel();
  const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const path = assignmentPath(assignmentId);
  const sessionFile = join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`);

  const loadout: Assignment['loadout'] = {
    harness: 'pi',
    profile: 'worker',
    role: 'investigation',
    model: `${model.provider}/${model.id}`,
    thinking: 'off',
    cwd: directory,
    agentDirectory: directory,
    permissions: 'trusted-full-tools',
    instructions: 'Inspect the fixture only.',
    tools: ['read', 'bash', 'codemode', 'ask_user_question'],
    skills: [],
    instructionSets: [],
    packages: [],
  };

  await writeAssignment({
    version: 1,
    assignmentId,
    task: 'Inspect source.txt.',
    acceptance: [],
    label: null,
    profile: 'worker',
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

  const created = await createPiSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: workerTools(loadout, skillTools),
    sessionManager: SessionManager.open(sessionFile),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionPaths: [safetyExtension],
    extensionFactories: [
      createCodemodeExtension({ mode: 'on' }),
      askUserQuestionExtension,
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

  return { outcomes, path };
};

const runManager = async (responses: FauxResponseStep[]) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-codemode-manager-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_ROLE', '');
  const provider = fauxProvider({ provider: 'tau-codemode-manager' });
  const sessionManager = SessionManager.create(directory, join(directory, 'sessions'));

  const { session } = await createPiSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: ['read', 'codemode', 'ask_user_question', ...managerTools],
    sessionManager,
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionFactories: [
      createCodemodeExtension({ mode: 'on' }),
      askUserQuestionExtension,
      (pi) => {
        subagentsExtension(pi, registerCapacityRefusal(pi));
      },
    ],
  });

  await session.bindExtensions({});

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
  await session.prompt('Check earlier workers.');

  return outcomes;
};

// Each attempt settles to its value or 'rejected', so one refused call cannot hide another.
const settle = (calls: string[]) =>
  [
    'const attempt = async (call) => call();',
    `const settled = await Promise.allSettled([${calls.map((call) => `attempt(() => ${call})`).join(', ')}]);`,
    "const outcomes = settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : 'rejected'));",
  ].join('\n');

const discovery = [
  'const listed = ALL_TOOLS.map((tool) => tool.name);',
  "const found = (await searchTools('subagent worker report ask user', { limit: 50 })).map((tool) => tool.name);",
].join('\n');

const stopWithoutReport = [
  fauxAssistantMessage('Stopping without a report.'),
  fauxAssistantMessage('Stopping without a report.'),
];

it('fails a script call to subagent_report without saving a report', async () => {
  const report = JSON.stringify({ outcome: 'success', summary: handover, evidence: [] });

  const { outcomes, path } = await runWorker([
    codemodeCall(`${settle([`tools.subagent_report(${report})`])}\nreturn outcomes;`),
    ...stopWithoutReport,
  ]);

  expect(scriptValue(outcomes)).toEqual(['rejected']);
  expect((await readAssignment(path))?.report).toBeNull();
});

it('hides worker control tools from scripts and saves no record for their calls', async () => {
  const report = JSON.stringify({ outcome: 'success', summary: handover, evidence: [] });

  const questionnaire = JSON.stringify({
    questions: [
      {
        header: 'Fixture',
        question: 'Which file?',
        options: [
          { label: 'Source', description: 'Inspect source.' },
          { label: 'Test', description: 'Inspect tests.' },
        ],
      },
    ],
  });

  const script = [
    discovery,
    settle([`tools.subagent_report(${report})`, `tools.ask_user_question(${questionnaire})`]),
    'return { listed, found, outcomes };',
  ].join('\n');

  const { outcomes, path } = await runWorker([codemodeCall(script), ...stopWithoutReport]);

  const value = scriptValue(outcomes) as { listed: string[]; found: string[]; outcomes: unknown[] };

  expect(value.listed).toContain('read');
  expect(value.listed.filter((name) => workerControlTools.has(name))).toEqual([]);
  expect(value.found.filter((name) => workerControlTools.has(name))).toEqual([]);
  expect(value.outcomes).toEqual(['rejected', 'rejected']);
  expect((await readAssignment(path))?.report).toBeNull();
});

it('returns ordinary results beside a refused control call in one script', async () => {
  const report = JSON.stringify({ outcome: 'success', summary: handover, evidence: [] });

  const script = [
    settle([
      "tools.read({ path: 'source.txt' })",
      "tools.bash({ command: 'printf bash-ok' }).then((result) => result.output)",
      `tools.subagent_report(${report})`,
    ]),
    'return outcomes;',
  ].join('\n');

  const { outcomes, path } = await runWorker([codemodeCall(script), ...stopWithoutReport]);

  const [read, bash, control] = scriptValue(outcomes) as unknown[];

  expect(read).toContain('fixture-source');
  expect(bash).toBe('bash-ok');
  expect(control).toBe('rejected');
  expect((await readAssignment(path))?.report).toBeNull();
});

it('lists the manager subagent tool but refuses it from a script', async () => {
  const script = [
    discovery,
    settle(["tools.subagent({ task: 'Check the fixture.', profile: 'scout' })"]),
    'return { listed, found, outcomes };',
  ].join('\n');

  const outcomes = await runManager([codemodeCall(script), fauxAssistantMessage('Done.')]);
  const value = scriptValue(outcomes) as { listed: string[]; found: string[]; outcomes: unknown[] };

  expect(value.listed).toContain('read');
  expect(value.listed.filter((name) => managerControlTools.has(name))).toEqual([]);
  expect(value.found.filter((name) => managerControlTools.has(name))).toEqual([]);
  expect(value.outcomes).toEqual(['rejected']);
});
