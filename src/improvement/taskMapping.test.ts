import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { decideCoverage, mapTasks } from './taskMapping.ts';
import type {
  Coverage,
  CoverageFacts,
  MappingFacts,
  MergedPullRequest,
  TranscriptFact,
} from './taskMapping.ts';
import { parseTranscript } from './transcript.ts';

const repository = 'github.com/sQVe/tau';

const fixtureText = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const fixture = (name: string, path = `/sessions/${name}`): TranscriptFact => ({
  path,
  transcript: parseTranscript(fixtureText(name)),
});

const ticketlessBranch = 'qa-guide-template-readable-shape';
const fallbackBranch = 'me-1449-remove-copied-helpers-and-stale-examples-that-agents';

const merged = (
  number: number,
  headBranch: string,
  createdAt = '2026-01-01T00:00:00Z',
): MergedPullRequest => ({ repository, number, headBranch, createdAt });

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

const factEntries = (input: Partial<MappingFacts>) =>
  mapTasks(facts(input)).tasks.map((task) => [
    task.pullRequest.number,
    task.facts.map((fact) => `${fact.kind} ${fact.entryId}`),
  ]);

describe('mapTasks', () => {
  it('maps each pull request of a root session that publishes several to its own slice', () => {
    const pullRequests = [
      merged(560, 'me-1023-launch-subagent-workers-as-hc-children-with-assignment-files'),
      merged(562, 'me-1024-carry-worker-questions-and-replies-over-hc'),
      merged(564, 'me-1025-enforce-worker-deadlines-with-an-hc-watchdog'),
    ];

    const mapped = factEntries({
      pullRequests,
      transcripts: [fixture('multiplePublications.jsonl')],
    });

    expect(mapped).toEqual([
      [
        560,
        [
          'launch 02362a6a',
          'checkFailure 579aacae',
          'reviewCapture 1481d9a5',
          'fixCapture 27b1bdef',
          'publication 064e4df0',
          'feedbackRound 262541be',
        ],
      ],
      [
        562,
        [
          'launch b31103a1',
          'launch 50f44c2a',
          'reviewCapture 8aa39720',
          'launch 8aa39720',
          'publication 898161cd',
          'feedbackRound f0954b2c',
        ],
      ],
      [564, ['launch 96d1974a', 'publication 80115b37']],
    ]);
  });

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
      entryId: '0775c033',
      timestamp: '2026-11-12T18:29:23.498Z',
    });

    expect(task?.coverage).toBe('complete');
  });

  it('makes the publication count unknown when a nested pr call has cut arguments', () => {
    const [task] = mapTasks(
      facts({
        pullRequests: [merged(660, ticketlessBranch)],
        transcripts: [fixture('branchWithoutTicket.jsonl')],
      }),
    ).tasks;

    expect(task?.missing.map((item) => [item.tool, item.entryId, item.affects])).toEqual([
      ['pr', '28885fb4', ['publication']],
      ['pr', 'f95dd84e', ['publication']],
    ]);

    expect(task?.counts.publications).toBe('unknown');
  });

  it('falls back to the transcript in the folder named by the ticket ID of the branch', () => {
    const [task] = mapTasks(
      facts({
        pullRequests: [merged(665, fallbackBranch)],
        transcripts: [fixture('withoutPublication.jsonl'), fixture('multiplePublications.jsonl')],
      }),
    ).tasks;

    expect(task?.transcripts).toEqual(['/sessions/withoutPublication.jsonl']);

    expect(task?.facts.map((fact) => `${fact.kind} ${fact.entryId}`)).toEqual([
      'checkFailure bc113404',
      'reviewCapture ec7ff06b',
      'launch 10b3b158',
      'feedbackRound 4c7bc974',
    ]);

    expect(task?.publication).toBeUndefined();
  });

  it('leaves out calls that name another pull request when it falls back to the ticket ID', () => {
    const otherRead = JSON.stringify({
      type: 'message',
      id: 'other-read',
      timestamp: '2026-11-15T06:30:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'c-other',
            name: 'pr_feedback',
            arguments: { action: 'read', repository, pr: 700 },
          },
        ],
      },
    });

    const otherResult = JSON.stringify({
      type: 'message',
      id: 'other-read-result',
      timestamp: '2026-11-15T06:30:01.000Z',
      message: { role: 'toolResult', toolCallId: 'c-other', details: {} },
    });

    const source = `${fixtureText('withoutPublication.jsonl')}${otherRead}\n${otherResult}\n`;

    const [task] = mapTasks(
      facts({
        pullRequests: [merged(665, fallbackBranch)],
        transcripts: [{ path: '/sessions/me-1449.jsonl', transcript: parseTranscript(source) }],
      }),
    ).tasks;

    expect(task?.facts.map((fact) => `${fact.kind} ${fact.entryId}`)).toEqual([
      'checkFailure bc113404',
      'reviewCapture ec7ff06b',
      'launch 10b3b158',
      'feedbackRound 4c7bc974',
    ]);
  });

  it('does not fall back to a transcript that publishes other pull requests', () => {
    const [task] = mapTasks(
      facts({
        pullRequests: [merged(559, 'me-1023-an-earlier-attempt')],
        transcripts: [fixture('multiplePublications.jsonl')],
      }),
    ).tasks;

    expect(task?.coverage).toBe('missing');
  });

  it('reports coverage missing for a pull request that no transcript maps to', () => {
    const [task] = mapTasks(
      facts({
        pullRequests: [merged(999, 'me-9999-unrelated-work')],
        transcripts: [fixture('withoutPublication.jsonl'), fixture('branchWithoutTicket.jsonl')],
      }),
    ).tasks;

    expect(task?.transcripts).toEqual([]);
    expect(task?.facts).toEqual([]);
    expect(task?.coverage).toBe('missing');
  });

  it('ignores a transcript whose cwd is in another repository', () => {
    const [task] = mapTasks(
      facts({
        pullRequests: [{ ...merged(665, fallbackBranch), repository: 'github.com/sQVe/other' }],
        transcripts: [fixture('withoutPublication.jsonl')],
      }),
    ).tasks;

    expect(task?.coverage).toBe('missing');
  });

  it('combines the facts of several transcripts and keeps the latest publication', () => {
    const later = [
      JSON.stringify({
        type: 'session',
        id: 'later',
        timestamp: '2026-11-03T08:00:00.000Z',
        cwd: '/home/sqve/code/personal/tau/me-1023',
      }),
      JSON.stringify({
        type: 'message',
        id: 'later-check',
        timestamp: '2026-11-03T08:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'full_check', arguments: {} }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'later-check-result',
        timestamp: '2026-11-03T08:02:00.000Z',
        message: { role: 'toolResult', toolCallId: 'c1', details: { passed: false } },
      }),
      JSON.stringify({
        type: 'message',
        id: 'later-verify',
        timestamp: '2026-11-03T08:03:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'c2',
              name: 'pr',
              arguments: { action: 'verify', repository, pr: 564 },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'later-verify-result',
        timestamp: '2026-11-03T08:04:00.000Z',
        message: { role: 'toolResult', toolCallId: 'c2', details: { matches: false } },
      }),
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
      entryId: 'later-verify',
      timestamp: '2026-11-03T08:03:00.000Z',
    });
  });

  it('keeps the result of a copied call when another copy has no result', () => {
    const sessionHeader = JSON.stringify({
      type: 'session',
      id: 's',
      timestamp: '2026-11-03T08:00:00.000Z',
      cwd: '/home/sqve/code/personal/tau/me-1023',
    });

    const verifyCall = JSON.stringify({
      type: 'message',
      id: 'verify',
      timestamp: '2026-11-03T08:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'c1',
            name: 'pr',
            arguments: { action: 'verify', repository, pr: 570 },
          },
        ],
      },
    });

    const verifyResult = JSON.stringify({
      type: 'message',
      id: 'verify-result',
      timestamp: '2026-11-03T08:02:00.000Z',
      message: { role: 'toolResult', toolCallId: 'c1', details: { matches: true } },
    });

    const complete = [sessionHeader, verifyCall, verifyResult].join('\n');
    const cut = [sessionHeader, verifyCall].join('\n');

    const [task] = mapTasks(
      facts({
        pullRequests: [merged(570, 'me-1023-a-later-change')],
        transcripts: [
          { path: '/sessions/complete.jsonl', transcript: parseTranscript(complete) },
          { path: '/sessions/cut.jsonl', transcript: parseTranscript(cut) },
        ],
      }),
    ).tasks;

    expect(task?.facts.map((fact) => `${fact.kind} ${fact.entryId}`)).toEqual([
      'publication verify',
    ]);

    expect(task?.counts.publications).toBe(1);
  });

  it('reports coverage unknown when a mapped transcript is malformed', () => {
    const transcript = parseTranscript(`${fixtureText('withoutPublication.jsonl')}{not json\n`);

    const [task] = mapTasks(
      facts({
        pullRequests: [merged(665, fallbackBranch)],
        transcripts: [{ path: '/sessions/broken.jsonl', transcript }],
      }),
    ).tasks;

    expect(task?.coverage).toBe('unknown');
  });

  it('lists transcripts without a cwd as unattributed', () => {
    const mapping = mapTasks(
      facts({
        transcripts: [
          fixture('withoutPublication.jsonl'),
          { path: '/sessions/gone.jsonl', transcript: parseTranscript(undefined) },
          {
            path: '/sessions/locked.jsonl',
            transcript: { status: 'unreadable', reason: 'EACCES' },
          },
          { path: '/sessions/headless.jsonl', transcript: parseTranscript('{"type":"message"}\n') },
        ],
      }),
    );

    expect(mapping.unattributed).toEqual([
      '/sessions/gone.jsonl',
      '/sessions/locked.jsonl',
      '/sessions/headless.jsonl',
    ]);
  });

  it('reads worker coverage from the launched worker IDs', () => {
    const pullRequests = [merged(665, fallbackBranch)];
    const transcripts = [fixture('withoutPublication.jsonl')];
    const workerId = '8f9d646e-8d7c-457e-a6e2-b6d107ce9d01';

    const coverageWith = (workers: MappingFacts['workers']) =>
      mapTasks(facts({ pullRequests, transcripts, workers })).tasks[0]?.coverage;

    expect(coverageWith(new Map([[workerId, 'readable']]))).toBe('complete');
    expect(coverageWith(new Map())).toBe('managerOnly');
  });
});

const entry = (id: string, timestamp: string, message: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', id, timestamp, message });

describe('mapTasks time bound', () => {
  const renamedCwd = '/home/sqve/code/personal/koja/me-80';

  const called = (id: string, timestamp: string, name: string, parameters: unknown) => [
    entry(id, timestamp, {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: parameters }],
    }),
    entry(`${id}-result`, timestamp, { role: 'toolResult', toolCallId: id, details: {} }),
  ];

  const transcript = parseTranscript(
    [
      JSON.stringify({ type: 'session', id: 's', timestamp: 't', cwd: renamedCwd }),
      ...called('old-read', '2026-10-20T10:00:00.000Z', 'pr_feedback', {
        action: 'read',
        repository,
        pr: 80,
      }),
      ...called('old-verify', '2026-10-21T10:00:00.000Z', 'pr', {
        action: 'verify',
        repository,
        pr: 80,
      }),
      ...called('new-capture', '2026-11-02T10:00:00.000Z', 'code_review', {
        action: 'capture',
        target: { kind: 'range' },
      }),
      ...called('new-verify', '2026-11-03T10:00:00.000Z', 'pr', {
        action: 'verify',
        repository,
        pr: 80,
      }),
    ].join('\n'),
  );

  const table: { rule: string; createdAt: string; facts: string[] }[] = [
    {
      rule: 'attributes every call when the pull request was created before them',
      createdAt: '2026-10-01T00:00:00Z',
      facts: [
        'feedbackRound old-read',
        'publication old-verify',
        'reviewCapture new-capture',
        'publication new-verify',
      ],
    },
    {
      rule: 'ignores a publication and a numbered call made before the pull request was created',
      createdAt: '2026-11-01T00:00:00Z',
      facts: ['reviewCapture new-capture', 'publication new-verify'],
    },
    {
      rule: 'compares the times, not their text',
      createdAt: '2026-11-03T10:00:00Z',
      facts: ['reviewCapture new-capture', 'publication new-verify'],
    },
    {
      rule: 'maps nothing when every publication is older than the pull request',
      createdAt: '2026-11-04T00:00:00Z',
      facts: [],
    },
  ];

  it.each(table.map((row) => [row.rule, row] as const))('%s', (_rule, row) => {
    const { createdAt, facts: expectedFacts } = row;

    const [task] = mapTasks(
      facts({
        pullRequests: [merged(80, 'normal-mode-picker-keys', createdAt)],
        transcripts: [{ path: '/sessions/koja.jsonl', transcript }],
        repositories: new Map([[renamedCwd, repository]]),
      }),
    ).tasks;

    expect(task?.facts.map((fact) => `${fact.kind} ${fact.entryId}`)).toEqual(expectedFacts);
  });
});

describe('decideCoverage', () => {
  const table: { rule: string; facts: CoverageFacts; coverage: Coverage }[] = [
    {
      rule: 'complete when every launched worker transcript is readable',
      facts: { mapped: true, malformed: false, workers: ['readable', 'readable'] },
      coverage: 'complete',
    },
    {
      rule: 'complete when the task launched no worker',
      facts: { mapped: true, malformed: false, workers: [] },
      coverage: 'complete',
    },
    {
      rule: 'managerOnly when a worker transcript is missing',
      facts: { mapped: true, malformed: false, workers: ['readable', 'missing'] },
      coverage: 'managerOnly',
    },
    {
      rule: 'managerOnly when a launch names no worker ID',
      facts: { mapped: true, malformed: false, workers: ['unknownId'] },
      coverage: 'managerOnly',
    },
    {
      rule: 'missing when no transcript maps',
      facts: { mapped: false, malformed: false, workers: [] },
      coverage: 'missing',
    },
    {
      rule: 'unknown when a worker transcript read failed',
      facts: { mapped: true, malformed: false, workers: ['missing', 'unreadable'] },
      coverage: 'unknown',
    },
    {
      rule: 'unknown when a manager transcript is malformed',
      facts: { mapped: true, malformed: true, workers: ['missing'] },
      coverage: 'unknown',
    },
  ];

  it.each(table)('$rule', ({ facts: coverageFacts, coverage }) => {
    expect(decideCoverage(coverageFacts)).toBe(coverage);
  });
});
