import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.ts';
import { panelMember, parseScoreArguments } from './questionGateScore.ts';

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

it.for<[string[], RegExp]>([
  [['--limit', '0'], /"0"/],
  [['--limit', 'x'], /"x"/],
  [['--holdout', '1'], /"1"/],
  [['--since', '7'], /"7"/],
])('rejects %j and names the value', ([argv, value]) => {
  expect(() => parseScoreArguments(argv, 0)).toThrow(value);
});

it('defaults to 500 questions and a 0.3 holdout', () => {
  expect(parseScoreArguments([], 0)).toEqual({
    since: undefined,
    until: undefined,
    limit: 500,
    holdout: 0.3,
  });
});

it('gives unavailable for an unknown reference', async () => {
  const found = registry(true, fauxAssistantMessage('Postgres'));

  expect(await panelMember(found, 'not-a-reference')(prompt, signal)).toEqual({
    kind: 'unavailable',
  });

  expect(
    await panelMember(registry(false, fauxAssistantMessage('Postgres')), 'a/one')(prompt, signal),
  ).toEqual({ kind: 'unavailable' });
});

it('gives error when the reply stops with an error or throws', async () => {
  const failed = registry(true, fauxAssistantMessage('Postgres', { stopReason: 'error' }));

  expect(await panelMember(failed, 'tau-fixture/judge-a')(prompt, signal)).toEqual({
    kind: 'error',
  });

  expect(
    await panelMember(registry(true, new Error('boom')), 'tau-fixture/judge-a')(prompt, signal),
  ).toEqual({ kind: 'error' });
});

it('gives the trimmed reply text when the reply stops', async () => {
  const replied = registry(true, fauxAssistantMessage('  Postgres \n'));

  expect(await panelMember(replied, 'tau-fixture/judge-a')(prompt, signal)).toEqual({
    kind: 'replied',
    text: 'Postgres',
  });
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
