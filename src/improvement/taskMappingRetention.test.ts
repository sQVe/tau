import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { keepFactCalls } from './taskFacts.ts';
import { mapTasks } from './taskMapping.ts';
import type { MappingFacts, MergedPullRequest, TranscriptFact } from './taskMapping.ts';
import { continueTranscript, finishTranscript, parseTranscript } from './transcript.ts';

const repository = 'github.com/sQVe/tau';

const fixtureNames = readdirSync(new URL('./fixtures/', import.meta.url)).filter((name) =>
  name.endsWith('.jsonl'),
);

const fixtureText = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const newlineTerminated = (source: string) => source.slice(0, source.lastIndexOf('\n') + 1);

const chunkedTranscript = (source: string) => {
  const terminated = newlineTerminated(source);

  let state = continueTranscript(undefined, '');

  for (const chunk of terminated.match(/[^\n]*\n/g) ?? []) {
    state = continueTranscript(state, chunk);
    state = { ...state, calls: keepFactCalls(state.calls) };
  }

  return finishTranscript(state);
};

const merged = (number: number, headBranch: string): MergedPullRequest => ({
  repository,
  number,
  headBranch,
  createdAt: '2026-01-01T00:00:00Z',
});

const pullRequests = [
  merged(1, 'me-1-special'),
  merged(560, 'me-1023-launch-subagent-workers-as-hc-children-with-assignment-files'),
  merged(562, 'me-1024-carry-worker-questions-and-replies-over-hc'),
  merged(564, 'me-1025-enforce-worker-deadlines-with-an-hc-watchdog'),
  merged(660, 'qa-guide-template-readable-shape'),
  merged(665, 'me-1449-remove-copied-helpers-and-stale-examples-that-agents'),
  merged(667, 'me-1450-move-session-log-readers-into-a-shared-improvement-module'),
];

const repositories = new Map([
  ['/home/sqve/code/personal/tau/me-1023', repository],
  ['/home/sqve/code/personal/tau/me-1449', repository],
  ['/home/sqve/code/personal/tau/me-1450', repository],
  ['/home/sqve/code/personal/tau/qa-guide-template-readable-shape', repository],
  ['/work/me-1', repository],
]);

const facts = (transcripts: TranscriptFact[]): MappingFacts => ({
  pullRequests,
  transcripts,
  repositories,
  workers: new Map(),
});

const header = JSON.stringify({ type: 'session', id: 's', timestamp: 't0', cwd: '/work/me-1' });

const message = (id: string, body: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', id, timestamp: `${id}-time`, message: body });

const toolCall = (id: string, name: string, parameters: unknown) =>
  message(`call-${id}`, {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: parameters }],
  });

const toolResult = (id: string, fields: Record<string, unknown>) =>
  message(`result-${id}`, { role: 'toolResult', toolCallId: id, ...fields });

const lines = (...entries: string[]) => `${entries.join('\n')}\n`;

const special = lines(
  header,
  toolCall('a', 'bash', { pr: 1, command: 'x' }),
  toolResult('a', { details: {} }),
  toolCall('b', 'pr', { action: 'verify', repository, pr: 1 }),
  toolResult('b', { details: { matches: true } }),
);

const fixtureFacts = (name: string): TranscriptFact => ({
  path: `/sessions/${name}`,
  transcript: parseTranscript(fixtureText(name)),
});

const chunkedFacts = (name: string): TranscriptFact => ({
  path: `/sessions/${name}`,
  transcript: chunkedTranscript(fixtureText(name)),
});

describe('mapTasks', () => {
  it('maps the same tasks from kept calls', () => {
    for (const name of fixtureNames) {
      expect(mapTasks(facts([chunkedFacts(name)])), name).toEqual(
        mapTasks(facts([fixtureFacts(name)])),
      );
    }

    const full = { path: '/sessions/special.jsonl', transcript: parseTranscript(special) };
    const kept = { path: '/sessions/special.jsonl', transcript: chunkedTranscript(special) };

    expect(mapTasks(facts([kept]))).toEqual(mapTasks(facts([full])));

    expect('calls' in kept.transcript && kept.transcript.calls.map((call) => call.tool)).toContain(
      'bash',
    );
  });
});
