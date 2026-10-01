import { describe, expect, it } from 'vitest';

import {
  formatTokenUsageReport,
  ownsSession,
  parseWorkerTask,
  tokenUsageReport,
} from './tokenUsageReport.js';
import type { SessionFile, TokenUsageReport, WorkerTask } from './tokenUsageReport.js';

interface Tokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const minute = (value: number) => `2026-09-01T10:${String(value).padStart(2, '0')}:00.000Z`;

const time = (value: number) => Date.parse(minute(value));

const window = { since: time(10), until: time(50) };

const header = (at: number) =>
  JSON.stringify({ type: 'session', id: `s${at}`, timestamp: minute(at), cwd: '/repo' });

const usage = (tokens: Tokens) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens });

const entry = (type: string, id: string, at: number, fields: Record<string, unknown>) =>
  JSON.stringify({ type, id, timestamp: minute(at), ...fields });

const assistant = (id: string, at: number, tokens: Tokens | undefined, model = 'opus') =>
  entry('message', id, at, {
    message: {
      role: 'assistant',
      provider: 'bridge',
      model,
      ...(tokens === undefined ? {} : { usage: usage(tokens) }),
    },
  });

const toolResult = (id: string, at: number, toolName: string, output: string, tokens?: Tokens) =>
  entry('message', id, at, {
    message: {
      role: 'toolResult',
      toolName,
      content: [{ type: 'text', text: output }, { type: 'image' }],
      ...(tokens === undefined ? {} : { usage: usage(tokens) }),
    },
  });

const task = (taskId: string, profile: string, createdAt: number): WorkerTask => ({
  taskId,
  harness: 'pi',
  name: taskId,
  profile,
  createdAt: time(createdAt),
  sessionFile: undefined,
});

const session = (path: string, lines: string[], tasks: WorkerTask[] = []): SessionFile => ({
  path,
  side: tasks.length > 0 ? 'worker' : 'parent',
  text: `${lines.join('\n')}\n`,
  tasks,
});

const noneSkipped = { unreadableFiles: 0, otherHarnessTasks: [] };

const report = (files: SessionFile[]) => tokenUsageReport(files, window, noneSkipped);

const groups = (result: TokenUsageReport) =>
  [...result.groups.values()].map((group) => ({
    profile: group.profile,
    model: group.model,
    sessions: group.sessions.size,
    turns: group.turns,
    tokens: group.tokens,
    firstRequests: group.firstRequests,
    finalContexts: [...group.finalContexts.values()],
  }));

const totals = (result: TokenUsageReport) =>
  [...result.kinds.values()].map((row) => [
    row.source,
    row.input + row.output + row.cacheRead + row.cacheWrite,
  ]);

describe('tokenUsageReport', () => {
  it('counts only entries inside the window of a recently active session', () => {
    const result = report([
      session('/p.jsonl', [
        header(0),
        assistant('a1', 5, { cacheWrite: 1000, output: 10 }),
        assistant('a2', 20, { input: 5, cacheRead: 1000, cacheWrite: 200, output: 20 }),
        assistant('a3', 55, { cacheRead: 1200, output: 30 }),
      ]),
    ]);

    expect([...result.kinds.values()]).toEqual([
      {
        side: 'parent',
        source: 'assistant',
        input: 5,
        output: 20,
        cacheRead: 1000,
        cacheWrite: 200,
      },
    ]);

    expect(groups(result)).toEqual([
      {
        profile: 'parent',
        model: 'bridge/opus',
        sessions: 1,
        turns: 1,
        tokens: 1225,
        firstRequests: [],
        finalContexts: [1205],
      },
    ]);
  });

  it('attributes a shared follow-up session to each task by its start time', () => {
    const result = report([
      session(
        '/w/a.jsonl',
        [
          header(11),
          assistant('a1', 12, { cacheWrite: 100 }),
          assistant('a2', 13, { cacheRead: 100, cacheWrite: 50 }),
          assistant('b1', 31, { cacheRead: 150, cacheWrite: 400 }),
          assistant('c1', 41, { cacheRead: 550, cacheWrite: 50 }),
        ],
        [task('c', 'scout', 40), task('b', 'reviewer', 30), task('a', 'scout', 11)],
      ),
    ]);

    expect(groups(result)).toEqual([
      expect.objectContaining({
        profile: 'scout',
        sessions: 1,
        turns: 3,
        firstRequests: [100],
        finalContexts: [150, 600],
      }),
      expect.objectContaining({
        profile: 'reviewer',
        sessions: 1,
        turns: 1,
        firstRequests: [],
        finalContexts: [550],
      }),
    ]);

    expect(result.sessions).toEqual([
      {
        path: '/w/a.jsonl',
        side: 'worker',
        owner: 'scout a, reviewer b, scout c',
        turns: 4,
        tokens: 1400,
      },
    ]);
  });

  it('counts entries a fork copied from its original once', () => {
    const original = [
      header(11),
      assistant('a1', 12, { cacheWrite: 100 }),
      toolResult('t1', 13, 'bash', 'abc'),
    ];

    const fork = [
      header(20),
      assistant('a1', 12, { cacheWrite: 100 }),
      toolResult('t1', 13, 'bash', 'abc'),
      assistant('f1', 21, { cacheRead: 100, cacheWrite: 20 }),
    ];

    const result = report([session('/fork.jsonl', fork), session('/original.jsonl', original)]);

    expect(result.copiedEntries).toBe(2);

    expect([...result.tools.values()]).toEqual([
      { side: 'parent', tool: 'bash', results: 1, characters: 3 },
    ]);

    expect(result.sessions.map((row) => [row.path, row.tokens])).toEqual([
      ['/original.jsonl', 100],
      ['/fork.jsonl', 120],
    ]);

    expect(groups(result)[0]).toMatchObject({ sessions: 2, turns: 2, firstRequests: [100] });
  });

  it('does not report copies of entries outside the window', () => {
    const original = [header(1), assistant('o1', 5, { cacheWrite: 100 })];

    const fork = [
      header(20),
      assistant('o1', 5, { cacheWrite: 100 }),
      assistant('f1', 21, { output: 4 }),
    ];

    const result = report([session('/original.jsonl', original), session('/fork.jsonl', fork)]);

    expect(result.copiedEntries).toBe(0);
    expect(result.sessions.map((row) => [row.path, row.tokens])).toEqual([['/fork.jsonl', 4]]);
  });

  it('skips malformed lines, entries without a time, and an incomplete tail', () => {
    const untimed = JSON.stringify({
      type: 'message',
      id: 'a0',
      message: { role: 'assistant', usage: usage({ output: 50 }) },
    });

    const lines = [
      header(11),
      '[1]',
      untimed,
      assistant('a1', 12, { output: 7 }),
      '{"type":"message","id":"a2',
    ];

    const result = report([{ ...session('/p.jsonl', lines), text: lines.join('\n') }]);

    expect(result.malformedLines).toBe(3);
    expect(result.sessions[0]).toMatchObject({ turns: 1, tokens: 7 });
  });

  it('counts assistant messages without usage apart from turns', () => {
    const result = report([
      session('/p.jsonl', [
        header(11),
        assistant('a1', 12, undefined),
        assistant('a2', 13, {}),
        assistant('a3', 14, { output: 3 }),
      ]),
    ]);

    expect(result.turnsWithoutUsage).toBe(2);
    expect(groups(result)[0]).toMatchObject({ turns: 1, tokens: 3, firstRequests: [0] });
  });

  it('adds compaction, usage entry, and tool model usage to totals without adding turns', () => {
    const result = report([
      session(
        '/w/a.jsonl',
        [
          header(11),
          assistant('a1', 12, { cacheWrite: 100 }),
          toolResult('t1', 13, 'bulk_read', 'answer', { input: 40, output: 4 }),
          entry('compaction', 'c1', 14, { usage: usage({ input: 300, output: 30 }) }),
          entry('usage', 'u1', 15, { kind: 'cache_warm', usage: usage({ cacheRead: 9 }) }),
          entry('custom_message', 'm1', 16, { usage: usage({ cacheRead: 5000 }) }),
        ],
        [task('a', 'worker', 11)],
      ),
    ]);

    expect(totals(result)).toEqual([
      ['assistant', 100],
      ['tool bulk_read', 44],
      ['compaction', 330],
      ['usage cache_warm', 9],
    ]);

    expect(result.sessions[0]).toMatchObject({ turns: 1, tokens: 483 });
    expect(groups(result)[0]).toMatchObject({ turns: 1, tokens: 100 });
  });

  it('splits a session across models when its model changes', () => {
    const result = report([
      session('/p.jsonl', [
        header(11),
        assistant('a1', 12, { cacheWrite: 100 }, 'opus'),
        entry('model_change', 'm1', 13, { provider: 'bridge', modelId: 'haiku' }),
        assistant('a2', 14, { cacheRead: 100, cacheWrite: 60 }, 'haiku'),
        assistant('a3', 15, { cacheRead: 160, cacheWrite: 40 }, 'haiku'),
      ]),
    ]);

    expect(groups(result)).toEqual([
      expect.objectContaining({
        model: 'bridge/opus',
        sessions: 1,
        turns: 1,
        firstRequests: [100],
        finalContexts: [100],
      }),
      expect.objectContaining({
        model: 'bridge/haiku',
        sessions: 1,
        turns: 2,
        firstRequests: [],
        finalContexts: [200],
      }),
    ]);
  });

  it('counts the Claude and Codex worker tasks that started inside the window', () => {
    const otherHarnessTasks = [
      task('a', 'worker', 5),
      task('b', 'worker', 20),
      task('c', 'worker', 55),
    ];

    const result = tokenUsageReport([], window, { unreadableFiles: 0, otherHarnessTasks });

    expect(result.otherHarnessTasks).toBe(1);
  });

  it('counts a file without a session header as unreadable and keeps the other files', () => {
    const result = tokenUsageReport(
      [
        session('/bad.jsonl', ['not json', assistant('a1', 12, { output: 5 })]),
        session('/good.jsonl', [header(11), assistant('a2', 12, { output: 2 })]),
      ],
      window,
      { unreadableFiles: 3, otherHarnessTasks: [] },
    );

    expect(result.unreadableFiles).toBe(4);
    expect(result.sessions.map((row) => row.path)).toEqual(['/good.jsonl']);
  });
});

describe('formatTokenUsageReport', () => {
  it('prints the median first request and final context across sessions', () => {
    const file = (path: string, first: number, final: number) =>
      session(path, [
        header(11),
        assistant(`${path}1`, 12, { cacheWrite: first }),
        assistant(`${path}2`, 13, { cacheRead: final }),
      ]);

    const result = report([
      file('/1', 10, 100),
      file('/2', 20, 300),
      file('/3', 60, 200),
      file('/4', 30, 900),
    ]);

    expect(formatTokenUsageReport(result, 5)).toMatch(
      /parent +bridge\/opus +4 +8 +1,620 +25 +250\n/,
    );
  });
});

describe('parseWorkerTask', () => {
  it.each([
    {
      rule: 'reads a current record',
      source:
        '{"taskId":"t","name":"scout-1","createdAt":5,"nativeSessionFile":"/w/s.jsonl","loadout":{"profile":"scout"}}',
      parsed: {
        taskId: 't',
        harness: 'pi',
        name: 'scout-1',
        profile: 'scout',
        createdAt: 5,
        sessionFile: '/w/s.jsonl',
      },
    },
    {
      rule: 'reads an old record without a session file or profile',
      source: '{"taskId":"t","createdAt":5}',
      parsed: {
        taskId: 't',
        harness: 'pi',
        name: 't',
        profile: 'unknown',
        createdAt: 5,
        sessionFile: undefined,
      },
    },
    {
      rule: 'reads the harness of a Codex worker',
      source: '{"taskId":"t","createdAt":5,"loadout":{"harness":"generic","profile":"worker"}}',
      parsed: {
        taskId: 't',
        harness: 'generic',
        name: 't',
        profile: 'worker',
        createdAt: 5,
        sessionFile: undefined,
      },
    },
    {
      rule: 'rejects a profile that is not text',
      source: '{"taskId":"t","createdAt":5,"loadout":{"profile":7}}',
      parsed: undefined,
    },
    {
      rule: 'rejects a harness that is not text',
      source: '{"taskId":"t","createdAt":5,"loadout":{"harness":["generic"]}}',
      parsed: undefined,
    },
    {
      rule: 'rejects a session file that is not text',
      source: '{"taskId":"t","createdAt":5,"nativeSessionFile":null}',
      parsed: undefined,
    },
    {
      rule: 'rejects a loadout that is not an object',
      source: '{"taskId":"t","createdAt":5,"loadout":"pi"}',
      parsed: undefined,
    },
    { rule: 'rejects a record without a start time', source: '{"taskId":"t"}', parsed: undefined },
    { rule: 'rejects malformed JSON', source: '{"taskId":', parsed: undefined },
  ])('$rule', ({ source, parsed }) => {
    expect(parseWorkerTask(source)).toEqual(parsed);
  });
});

describe('ownsSession', () => {
  it.each([
    {
      rule: 'owns the session beside its record',
      directory: '/w/a',
      sessionFile: undefined,
      owns: true,
    },
    {
      rule: 'owns the session a follow-up names',
      directory: '/w/b',
      sessionFile: '/w/a/s.jsonl',
      owns: true,
    },
    {
      rule: 'owns a session named by a copied record',
      directory: '/w/b',
      sessionFile: '/old/w/a/s.jsonl',
      owns: true,
    },
    {
      rule: 'does not own another session',
      directory: '/w/c',
      sessionFile: '/w/c/other.jsonl',
      owns: false,
    },
  ])('$rule', ({ directory, sessionFile, owns }) => {
    expect(
      ownsSession({ ...task('t', 'worker', 11), sessionFile }, directory, '/w/a/s.jsonl'),
    ).toBe(owns);
  });
});
