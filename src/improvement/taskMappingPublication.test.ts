import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { mapTasks } from './taskMapping.ts';
import type { MappingFacts, MergedPullRequest, TranscriptFact } from './taskMapping.ts';
import { parseTranscript } from './transcript.ts';

const repository = 'github.com/sQVe/tau';

const fixtureText = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const fixture = (name: string, path = `/sessions/${name}`): TranscriptFact => ({
  path,
  transcript: parseTranscript(fixtureText(name)),
});

const merged = (
  number: number,
  headBranch: string,
  createdAt = '2026-01-01T00:00:00Z',
): MergedPullRequest => ({
  repository,
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  headBranch,
  createdAt,
  mergedAt: '2026-11-15T12:00:00Z',
});

const facts = (input: Partial<MappingFacts>): MappingFacts => ({
  pullRequests: [],
  transcripts: [],
  repositories: new Map([
    ['/home/sqve/code/personal/tau/me-1023', repository],
    ['/home/sqve/code/personal/tau/me-1449', repository],
    ['/home/sqve/code/personal/tau/qa-guide-template-readable-shape', repository],
  ]),
  workers: new Map(),
  ...input,
});

const entry = (id: string, timestamp: string, message: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', id, timestamp, message });

const sessionHeader = (cwd: string) =>
  JSON.stringify({ type: 'session', id: 's', timestamp: '2026-01-01T00:00:00.000Z', cwd });

const toolCall = (id: string, timestamp: string, name: string, parameters: unknown) =>
  entry(id, timestamp, {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: parameters }],
  });

const called = (
  id: string,
  timestamp: string,
  name: string,
  parameters: unknown,
  details: Record<string, unknown> = {},
) => [
  toolCall(id, timestamp, name, parameters),
  entry(`${id}-result`, timestamp, { role: 'toolResult', toolCallId: id, details }),
];

const ticketlessBranch = 'qa-guide-template-readable-shape';

it('maps a pull request whose branch has no ticket ID through its publication', () => {
  const [task] = mapTasks(
    facts({
      pullRequests: [merged(660, ticketlessBranch)],
      transcripts: [fixture('branchWithoutTicket.jsonl')],
      workers: new Map([['47941926-f23d-42e5-9aa8-a9ff7b9d2cc7', 'readable']]),
    }),
  ).tasks;

  expect(task?.facts.map((fact) => `${fact.kind} ${fact.entryId}`)).toEqual([
    'reviewCapture 6fa2e153',
    'launch 743ddde1',
    'checkFailure f95dd84e',
    'publication 0775c033',
    'feedbackRound edf31f5e',
  ]);

  expect(task?.publication).toEqual({
    path: '/sessions/branchWithoutTicket.jsonl',
    callId: 'toolu_01KPUpwjsRnJxnLDxkDy3GkR',
    entryId: '0775c033',
    timestamp: '2026-11-12T18:29:23.498Z',
  });

  expect(task?.coverage).toBe('complete');
});

it('combines the facts of several transcripts and keeps the latest publication', () => {
  const later = [
    sessionHeader('/home/sqve/code/personal/tau/me-1023'),
    ...called('later-check', '2026-11-03T08:01:00.000Z', 'full_check', {}, { passed: false }),
    ...called(
      'later-verify',
      '2026-11-03T08:03:00.000Z',
      'pr',
      { action: 'verify', repository, pr: 564 },
      { matches: false },
    ),
  ].join('\n');

  const [task] = mapTasks(
    facts({
      pullRequests: [merged(564, 'me-1025-enforce-worker-deadlines-with-an-hc-watchdog')],
      transcripts: [
        fixture('multiplePublications.jsonl'),
        fixture('multiplePublications.jsonl', '/sessions/fork.jsonl'),
        { path: '/sessions/later.jsonl', transcript: parseTranscript(later) },
      ],
    }),
  ).tasks;

  expect(task?.facts.map((fact) => `${fact.kind} ${fact.entryId}`)).toEqual([
    'launch 96d1974a',
    'publication 80115b37',
    'checkFailure later-check',
    'publication later-verify',
  ]);

  expect(task?.publication).toEqual({
    path: '/sessions/later.jsonl',
    callId: 'later-verify',
    entryId: 'later-verify',
    timestamp: '2026-11-03T08:03:00.000Z',
  });
});
