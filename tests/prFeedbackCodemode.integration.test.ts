import { resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { createGhFake } from '../src/extensions/prFeedback/fixtures/ghFake.js';
import type {
  FakeCheck,
  FakeThread,
  GhFake,
} from '../src/extensions/prFeedback/fixtures/ghFake.js';
import { createPrFeedbackTool } from '../src/extensions/prFeedback/tool.js';
import tauSkillsExtension from '../src/extensions/tauSkills/tauSkills.js';
import { skillTools } from '../src/tau.js';
import { createTemporaryRepository } from './gitRepository.js';
import { createBoundSession } from './piSession.js';

interface Gap {
  action: string;
  check?: string | null;
  reason: string;
}

interface EvidenceResult {
  read: {
    status: string;
    value?: {
      viewer: string;
      pr: { author: string; headRefOid: string };
      directory: string;
      stateToken: string;
      threads: { id: string }[];
      reviews: { id: number }[];
      comments: { id: number }[];
    };
  };
  checks: {
    status: string;
    reason?: string;
    value?: { checks: { name: string; bucket: string; log?: unknown; gap?: unknown }[] };
  };
  gaps: Gap[];
}

// Real Pi sessions need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

const skillsDirectory = resolve(import.meta.dirname, '../src/skills');

// The evidence script the pr-feedback skill describes: read runs first, and checks runs at read's
// head. Each outcome is kept, and every failed, skipped, or incomplete read becomes a gap.
const evidenceScript = `
const repository = 'github.com/sQVe/tau';
const pr = 7;
const call = async (input) => JSON.parse(await tools.pr_feedback({ repository, pr, ...input }));
const settle = (promise) =>
  promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', reason: String(error?.message ?? error) }),
  );
const read = await settle(call({ action: 'read' }));
const gaps = [];
if (read.status === 'rejected') {
  gaps.push({ action: 'read', reason: read.reason });
  gaps.push({ action: 'checks', reason: 'checks did not run, because read failed.' });
  return { read, checks: { status: 'not run' }, gaps };
}
const checks = await settle(call({ action: 'checks', head: read.value.pr.headRefOid }));
if (checks.status === 'rejected') gaps.push({ action: 'checks', reason: checks.reason });
else gaps.push(...checks.value.gaps.map((gap) => ({ action: 'checks', ...gap })));
return { read, checks, gaps };
`;

// A script's `return` value is the last text block of the codemode result, as JSON.
const scriptValue = (result: unknown): EvidenceResult => {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  const output = content.findLast((block) => block.type === 'text')?.text ?? '';

  return JSON.parse(output) as EvidenceResult;
};

// Runs the evidence script in a Pi session after `/pr-feedback` turns the tool on.
const runEvidenceScript = async (fake: GhFake) => {
  const directory = await createTemporaryRepository(onTestFinished, 'tau-pr-feedback-codemode-');
  const provider = fauxProvider({ provider: 'tau-pr-feedback-codemode' });

  const registerTools = (pi: ExtensionAPI) => {
    pi.registerTool(createPrFeedbackTool(fake.exec));
    tauSkillsExtension(pi, skillsDirectory, skillTools);
  };

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    settings: {
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultTools: ['read', 'codemode'],
    },
    extensionFactories: [createCodemodeExtension({ mode: 'on' }), registerTools],
  });

  const scripts: { isError: boolean; result: unknown }[] = [];
  const settled = Promise.withResolvers<undefined>();

  session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.toolName === 'codemode') {
      scripts.push({ isError: event.isError, result: event.result });
    }

    if (event.type === 'agent_settled') {
      settled.resolve(undefined);
    }
  });

  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('codemode', { code: evidenceScript })]),
    fauxAssistantMessage('Done.'),
  ]);

  // The command queues the skill message as a follow-up, so the run starts after prompt returns.
  await session.prompt('/pr-feedback 7');
  await settled.promise;

  const [script] = scripts;

  if (script === undefined || script.isError) {
    throw new Error(`Script did not complete: ${JSON.stringify(script?.result)}`);
  }

  return scriptValue(script.result);
};

// Typed as unknown, because the asymmetric matchers are typed as any.
const anyGap: unknown = expect.anything();
const anyReason: unknown = expect.any(String);

const thread = (id: string, overrides: Partial<FakeThread> = {}): FakeThread => ({
  id,
  path: 'src/a.ts',
  line: 1,
  isResolved: false,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  hasMoreComments: false,
  comments: [{ id: Number(id.slice(1)), author: { login: 'reviewer', bot: false }, body: 'Fix.' }],
  ...overrides,
});

const passingCheck: FakeCheck = {
  name: 'lint',
  workflow: 'CI',
  bucket: 'pass',
  state: 'SUCCESS',
  link: 'https://github.com/sQVe/tau/actions/runs/11/job/20',
};

const failingCheck: FakeCheck = {
  name: 'test',
  workflow: 'CI',
  bucket: 'fail',
  state: 'FAILURE',
  link: 'https://github.com/sQVe/tau/actions/runs/11/job/21',
};

it('returns threads, reviews, and comments from several pages and a gap for a failing check whose log command failed', async () => {
  const fake = createGhFake();
  const reviewer = { login: 'reviewer', bot: false };

  fake.threads = [thread('t1'), thread('t2'), thread('t3')];

  fake.reviews = [
    { id: 41, author: reviewer, body: 'First.', state: 'COMMENTED' },
    { id: 42, author: reviewer, body: 'Second.', state: 'CHANGES_REQUESTED' },
  ];

  fake.comments = [
    { id: 51, author: reviewer, body: 'One.' },
    { id: 52, author: reviewer, body: 'Two.' },
  ];

  fake.checks = [passingCheck, failingCheck];
  fake.checksExitCode = 1;
  fake.jobLogs = { '21': { code: 1, stderr: 'HTTP 502: Bad Gateway' } };

  const result = await runEvidenceScript(fake);
  const feedback = result.read.value;

  expect(feedback?.threads.map((item) => item.id)).toEqual(['t1', 't2', 't3']);
  expect(feedback?.reviews.map((item) => item.id)).toEqual([41, 42]);
  expect(feedback?.comments.map((item) => item.id)).toEqual([51, 52]);
  expect(feedback).toMatchObject({ viewer: 'sqve', pr: { author: 'sqve', headRefOid: 'abc123' } });
  expect(feedback?.directory).toMatch(/\.tau\/pr-feedback\/7-/);
  expect(feedback?.stateToken).toEqual(expect.any(String));

  const failing = result.checks.value?.checks.find((check) => check.name === 'test');

  expect(failing).toMatchObject({ bucket: 'fail', gap: anyGap });
  expect(failing).not.toHaveProperty('log');
  expect(result.gaps).toEqual([expect.objectContaining({ action: 'checks', check: 'test' })]);
});

it('returns a gap for a pull request with no checks', async () => {
  const fake = createGhFake();

  fake.checks = [];

  const result = await runEvidenceScript(fake);

  expect(result.read.status).toBe('fulfilled');
  expect(result.checks.value?.checks).toEqual([]);
  expect(result.gaps).toEqual([expect.objectContaining({ action: 'checks', check: null })]);
});

it('returns a gap for a failing check with no readable log', async () => {
  const fake = createGhFake();

  fake.checks = [{ ...failingCheck, link: 'https://ci.example.com/build/9' }];
  fake.checksExitCode = 1;

  const result = await runEvidenceScript(fake);
  const [check] = result.checks.value?.checks ?? [];

  expect(check).toMatchObject({ name: 'test', bucket: 'fail', gap: anyGap });
  expect(check).not.toHaveProperty('log');
  expect(result.gaps).toEqual([expect.objectContaining({ action: 'checks', check: 'test' })]);
});

it('returns the read error and a skipped checks call as gaps when a thread is too long to read', async () => {
  const fake = createGhFake();

  fake.threads = [thread('t1', { hasMoreComments: true })];
  fake.checks = [passingCheck];

  const result = await runEvidenceScript(fake);

  expect(result.read).toMatchObject({ status: 'rejected' });
  expect(result.read).not.toHaveProperty('value');
  expect(result.checks).toEqual({ status: 'not run' });

  expect(result.gaps).toEqual([
    { action: 'read', reason: anyReason },
    { action: 'checks', reason: anyReason },
  ]);

  expect(fake.calls.some((call) => call.commandArguments[1] === 'checks')).toBe(false);
});

it('returns the refusal instead of checks when the head moves after read', async () => {
  const fake = createGhFake();

  fake.checks = [passingCheck];
  // read, then checks before and after its list.
  fake.nextHeads = ['abc123', 'abc123', 'def456'];

  const result = await runEvidenceScript(fake);

  expect(result.read.value?.pr.headRefOid).toBe('abc123');
  expect(result.checks).not.toHaveProperty('value');

  expect(result.checks).toEqual({
    status: 'rejected',
    reason: expect.stringContaining('The pull request head is def456, not abc123.') as unknown,
  });

  expect(result.gaps).toEqual([{ action: 'checks', reason: result.checks.reason }]);
});

it('returns a gap and no passing checks when the check list cannot be read', async () => {
  const fake = createGhFake();

  fake.checks = [passingCheck];
  fake.failCommand('pr checks');

  const result = await runEvidenceScript(fake);

  expect(result.read.status).toBe('fulfilled');
  expect(result.checks.value?.checks).toEqual([]);
  expect(result.gaps).toEqual([expect.objectContaining({ action: 'checks', check: null })]);
});
