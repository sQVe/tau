import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.ts';
import { panelMember, parseScoreArguments, writePanelMemberErrors } from './questionGateScore.ts';

const script = join(import.meta.dirname, 'questionGateScore.ts');

const prompt = { system: 'Pick one option.', user: '{"question":"Which database?"}' };
const signal = new AbortController().signal;

const registry = (found: boolean, reply: AssistantMessage | Error): ModelRegistry =>
  ({
    find: (provider: string, id: string) => (found ? { provider, id } : undefined),
    complete: async () => {
      if (reply instanceof Error) {
        throw reply;
      }

      return reply;
    },
  }) as unknown as ModelRegistry;

const sequenceRegistry = (
  replies: readonly AssistantMessage[],
): { registry: ModelRegistry; callCount: () => number } => {
  let calls = 0;

  const fake = {
    find: (provider: string, id: string) => ({ provider, id }),
    complete: async () => {
      const reply = replies[Math.min(calls, replies.length - 1)];

      calls += 1;

      return reply;
    },
  } as unknown as ModelRegistry;

  return { registry: fake, callCount: () => calls };
};

const noErrors = () => {};

const diagnostics = (recordError: (message: string) => void = noErrors) => ({
  retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  recordError,
});

const rateLimited = fauxAssistantMessage('', {
  stopReason: 'error',
  errorMessage: 'OpenAI API error (429): 429 {"detail":"Rate limit exceeded"}',
});

it.for<[string[], RegExp]>([
  [['--limit', '0'], /"0"/],
  [['--limit', 'x'], /"x"/],
  [['--holdout', '1'], /"1"/],
  [['--since', '7'], /"7"/],
])('rejects %j and names the value', ([argv, value]) => {
  expect(() => parseScoreArguments(argv, 0)).toThrow(value);
});

const invalidTimeMessage = (argv: string[]) => {
  try {
    parseScoreArguments(argv, 0);
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }

  return '';
};

it('names its own usage when a time is invalid', () => {
  expect(invalidTimeMessage(['--since', '7'])).toContain(
    'Usage: node scripts/questionGateScore.ts',
  );

  expect(invalidTimeMessage(['--until', 'soon'])).toContain(
    'Usage: node scripts/questionGateScore.ts',
  );

  expect(invalidTimeMessage(['--since', '7'])).not.toContain('Usage: node scripts/tokenUsage.ts');
});

it('defaults to 500 questions and a 0.3 holdout', () => {
  expect(parseScoreArguments([], 0)).toEqual({
    kind: 'history',
    since: undefined,
    until: undefined,
    limit: 500,
    holdout: 0.3,
  });
});

it('returns the shadow variant without historical defaults', () => {
  expect(parseScoreArguments(['--shadow'], 0)).toEqual({ kind: 'shadow' });
});

it.for<[string, string]>([
  ['--since', '1'],
  ['--until', '1'],
  ['--limit', '3'],
  ['--holdout', '0.2'],
])('rejects %s with --shadow', ([flag, value]) => {
  expect(() => parseScoreArguments(['--shadow', flag, value], 0)).toThrow(flag);
});

it('gives unavailable for an unknown reference', async () => {
  const found = registry(true, fauxAssistantMessage('Postgres'));

  expect(await panelMember(found, 'not-a-reference', diagnostics())(prompt, signal)).toEqual({
    kind: 'unavailable',
  });

  expect(
    await panelMember(
      registry(false, fauxAssistantMessage('Postgres')),
      'a/one',
      diagnostics(),
    )(prompt, signal),
  ).toEqual({ kind: 'unavailable' });
});

it('gives error when the reply stops with an error or throws', async () => {
  const failed = registry(true, fauxAssistantMessage('Postgres', { stopReason: 'error' }));

  expect(await panelMember(failed, 'tau-fixture/judge-a', diagnostics())(prompt, signal)).toEqual({
    kind: 'error',
  });

  expect(
    await panelMember(
      registry(true, new Error('boom')),
      'tau-fixture/judge-a',
      diagnostics(),
    )(prompt, signal),
  ).toEqual({ kind: 'error' });
});

it('retries a rate-limited reply and returns the later reply', async () => {
  const { registry: retrying, callCount } = sequenceRegistry([
    rateLimited,
    fauxAssistantMessage('Postgres'),
  ]);

  const errors: string[] = [];

  const member = panelMember(
    retrying,
    'tau-fixture/judge-a',
    diagnostics((message) => errors.push(message)),
  );

  expect(await member(prompt, signal)).toEqual({ kind: 'replied', text: 'Postgres' });
  expect(callCount()).toBe(2);
  expect(errors).toEqual([]);
});

it('stamps the request time on each retry attempt', async () => {
  const retried = fauxAssistantMessage('Postgres');
  const timestamps: unknown[] = [];

  const complete = vi.fn<(model: unknown, context: Context) => Promise<AssistantMessage>>(
    async (_model, context) => {
      timestamps.push(context.messages[0]?.timestamp);

      return timestamps.length === 1 ? rateLimited : retried;
    },
  );

  const fake = {
    find: (provider: string, id: string) => ({ provider, id }),
    complete,
  } as unknown as ModelRegistry;

  const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);

  try {
    const member = panelMember(fake, 'tau-fixture/judge-a', diagnostics());

    expect(await member(prompt, signal)).toEqual({ kind: 'replied', text: 'Postgres' });
    expect(timestamps).toEqual([1_000, 2_000]);
  } finally {
    now.mockRestore();
  }
});

it('records the error message when retries are exhausted', async () => {
  const { registry: limited, callCount } = sequenceRegistry([rateLimited]);
  const errors: string[] = [];

  const member = panelMember(
    limited,
    'tau-fixture/judge-a',
    diagnostics((message) => errors.push(message)),
  );

  expect(await member(prompt, signal)).toEqual({ kind: 'error' });
  expect(callCount()).toBe(2);
  expect(errors).toEqual([rateLimited.errorMessage]);
});

it('records the message of a thrown member error', async () => {
  const errors: string[] = [];
  const failing = registry(true, new Error('offline'));

  const member = panelMember(
    failing,
    'tau-fixture/judge-a',
    diagnostics((message) => errors.push(message)),
  );

  expect(await member(prompt, signal)).toEqual({ kind: 'error' });
  expect(errors).toEqual(['offline']);
});

it('gives the trimmed reply text when the reply stops', async () => {
  const replied = registry(true, fauxAssistantMessage('  Postgres \n'));

  expect(await panelMember(replied, 'tau-fixture/judge-a', diagnostics())(prompt, signal)).toEqual({
    kind: 'replied',
    text: 'Postgres',
  });
});

it('writes one line per model with its error count and first message', () => {
  const lines: string[] = [];

  writePanelMemberErrors(
    [
      { model: 'tau-fixture/judge-a', message: 'OpenAI API error (429): rate limit exceeded' },
      { model: 'tau-fixture/judge-a', message: 'a later message is not shown' },
      { model: 'tau-fixture/judge-b', message: 'offline' },
    ],
    (line) => lines.push(line),
  );

  expect(lines).toEqual([
    'Panel member errors: tau-fixture/judge-a: 2 errors, first: OpenAI API error (429): rate limit exceeded',
    'Panel member errors: tau-fixture/judge-b: 1 error, first: offline',
  ]);
});

it('exits 1 naming questionGate when the user config lacks it', ({ onTestFinished }) => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-question-gate-');

  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('questionGate');
});

it('scores history when only the shadow block is invalid', ({ onTestFinished }) => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-question-gate-');

  writeFileSync(
    join(agentDirectory, 'tau.json'),
    JSON.stringify({
      questionGate: {
        classifier: 'fixture/classifier',
        panel: ['fixture/panel-a', 'fixture/panel-b', 'fixture/panel-c'],
        shadow: { variant: 'classifierExamples', cutoff: 0.8, examples: [] },
      },
    }),
  );

  const result = spawnSync(process.execPath, [script, '--limit', '1'], {
    encoding: 'utf8',
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
  });

  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('Invalid Tau config');
  expect(result.stderr).not.toContain('Judged');
  expect(result.stdout).toContain('Questions: 0 tuning, 0 held out');
});
