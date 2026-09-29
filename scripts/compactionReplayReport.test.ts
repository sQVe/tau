import { expect, it } from 'vitest';

import { compactionReplayReport, replayTurn } from './compactionReplayReport.js';
import type { CompactionReplayReport } from './compactionReplayReport.js';
import type { SessionFile, Usage } from './tokenUsageReport.js';

const usage = (tokens: Partial<Usage>): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...tokens,
});

const state = (base: number | undefined, previousReal: number, simulated: number) => ({
  base,
  previousReal,
  simulated,
});

// keepRecentTokens is 20,000, so a reset context is base + 20,000 + summary.
it.each([
  {
    rule: 'takes the first turn as the base context',
    before: state(undefined, 0, 0),
    turn: usage({ cacheWrite: 10_000, output: 500 }),
    request: usage({ cacheWrite: 10_000, output: 500 }),
    compaction: undefined,
    after: state(10_000, 10_000, 10_000),
  },
  {
    rule: 'replays a turn below the threshold as it happened',
    before: state(10_000, 100_000, 100_000),
    turn: usage({ input: 3, cacheRead: 100_000, cacheWrite: 5000, output: 1000 }),
    request: usage({ input: 3, cacheRead: 100_000, cacheWrite: 5000, output: 1000 }),
    compaction: undefined,
    after: state(10_000, 105_003, 105_003),
  },
  {
    rule: 'compacts once the context passed the threshold and writes the new context',
    before: state(10_000, 160_000, 160_000),
    turn: usage({ cacheRead: 160_000, cacheWrite: 5000, output: 1000 }),
    request: usage({ cacheWrite: 39_000, output: 1000 }),
    compaction: usage({ input: 130_000, output: 4000 }),
    after: state(10_000, 165_000, 39_000),
  },
  {
    rule: 'sends the whole context as input after a compaction without cache writes',
    before: state(10_000, 160_000, 160_000),
    turn: usage({ input: 5000, cacheRead: 160_000, output: 1000 }),
    request: usage({ input: 39_000, output: 1000 }),
    compaction: usage({ input: 130_000, output: 4000 }),
    after: state(10_000, 165_000, 39_000),
  },
  {
    rule: 'reads the cached prefix after a compaction',
    before: state(10_000, 165_000, 39_000),
    turn: usage({ input: 2, cacheRead: 165_000, cacheWrite: 3000, output: 1000 }),
    request: usage({ input: 2, cacheRead: 39_000, cacheWrite: 3000, output: 1000 }),
    compaction: undefined,
    after: state(10_000, 168_002, 42_002),
  },
  {
    rule: 'caps a real cache miss at the simulated context',
    before: state(10_000, 165_000, 39_000),
    turn: usage({ cacheWrite: 170_000, output: 1000 }),
    request: usage({ cacheWrite: 44_000, output: 1000 }),
    compaction: undefined,
    after: state(10_000, 170_000, 44_000),
  },
  {
    rule: 'caps the context at a real context drop',
    before: state(10_000, 900_000, 120_000),
    turn: usage({ cacheWrite: 50_000, output: 1000 }),
    request: usage({ cacheWrite: 50_000, output: 1000 }),
    compaction: undefined,
    after: state(10_000, 50_000, 50_000),
  },
  {
    rule: 'keeps a smaller context through a real context drop',
    before: state(10_000, 900_000, 40_000),
    turn: usage({ cacheRead: 45_000, cacheWrite: 5000 }),
    request: usage({ cacheRead: 35_000, cacheWrite: 5000 }),
    compaction: undefined,
    after: state(10_000, 50_000, 40_000),
  },
])('$rule', ({ before, turn, request, compaction, after }) => {
  const replayState = { ...before };

  expect(replayTurn(replayState, turn, 150_000, 4000)).toEqual({ request, compaction });
  expect(replayState).toEqual(after);
});

const minute = (value: number) => `2026-09-01T10:${String(value).padStart(2, '0')}:00.000Z`;

const window = { since: Date.parse(minute(10)), until: Date.parse(minute(50)) };

const header = (at: number) =>
  JSON.stringify({ type: 'session', id: `s${at}`, timestamp: minute(at), cwd: '/repo' });

const assistant = (id: string, at: number, tokens: Partial<Usage>, model = 'opus') =>
  JSON.stringify({
    type: 'message',
    id,
    timestamp: minute(at),
    message: { role: 'assistant', provider: 'bridge', model, usage: usage(tokens) },
  });

const realCompaction = (id: string, at: number, summary: string, tokens: Partial<Usage>) =>
  JSON.stringify({
    type: 'compaction',
    id,
    timestamp: minute(at),
    summary,
    firstKeptEntryId: id,
    tokensBefore: 100_000,
    usage: usage(tokens),
  });

const session = (path: string, lines: string[]): SessionFile => ({
  path,
  side: 'parent',
  text: `${lines.join('\n')}\n`,
  tasks: [],
});

const rows = (report: CompactionReplayReport) =>
  report.replays.map((replay) =>
    [...replay.models.values()].map((row) => ({
      threshold: replay.threshold,
      model: row.model,
      sessions: row.sessions.size,
      compactingSessions: row.compactingSessions.size,
      compactions: row.compactions,
      real: row.real,
      simulated: row.simulated,
    })),
  );

// Grows by 50,000 per turn from a 10,000 base: 10k, 60k, 110k, 160k, 210k.
const growingSession = (path: string, from: number) =>
  session(path, [
    header(from),
    ...[0, 1, 2, 3, 4].map((turn) =>
      assistant(`${path}-${turn}`, from + turn, {
        cacheRead: turn === 0 ? 0 : 10_000 + (turn - 1) * 50_000,
        cacheWrite: turn === 0 ? 10_000 : 50_000,
        output: 100,
      }),
    ),
  ]);

it('replays each threshold per model and charges each compaction', () => {
  const report = compactionReplayReport([growingSession('a', 10)], window, [100_000, 300_000], 0);

  expect(rows(report)).toEqual([
    [
      {
        threshold: 100_000,
        model: 'bridge/opus',
        sessions: 1,
        compactingSessions: 1,
        compactions: 1,
        real: usage({ cacheRead: 340_000, cacheWrite: 210_000, output: 500 }),
        // Turn 3 resets to 10,000 + 20,000, grows 50,000, and writes all 80,000. The compaction
        // summarizes 110,000 - 10,000 - 20,000.
        simulated: usage({ input: 80_000, cacheRead: 150_000, cacheWrite: 240_000, output: 500 }),
      },
    ],
    [
      {
        threshold: 300_000,
        model: 'bridge/opus',
        sessions: 1,
        compactingSessions: 0,
        compactions: 0,
        real: usage({ cacheRead: 340_000, cacheWrite: 210_000, output: 500 }),
        simulated: usage({ cacheRead: 340_000, cacheWrite: 210_000, output: 500 }),
      },
    ],
  ]);
});

it('counts only turns inside the window and each copied turn once', () => {
  const original = growingSession('a', 8);
  const fork = session('b', [header(9), ...original.text.trim().split('\n').slice(1)]);
  const report = compactionReplayReport([fork, original], window, [1_000_000], 0);

  expect(rows(report)[0]?.map((row) => [row.sessions, row.real])).toEqual([
    [1, usage({ cacheRead: 330_000, cacheWrite: 150_000, output: 300 })],
  ]);

  expect(report.copiedEntries).toBe(3);
});

it('sizes the summary from real compactions and charges them on both sides', () => {
  const file = session('a', [
    header(10),
    assistant('t1', 11, { cacheWrite: 10_000 }),
    realCompaction('c1', 12, 'x'.repeat(8000), { input: 40_000, output: 2000 }),
    realCompaction('c2', 13, 'x'.repeat(4000), { input: 60_000, output: 1000 }),
  ]);

  const report = compactionReplayReport([file], window, [1_000_000], 0);
  const [row] = rows(report)[0] ?? [];

  expect([report.summaryTokens, report.summarizerInputShare]).toEqual([1500, 0.5]);
  expect(row?.real).toEqual(usage({ input: 100_000, cacheWrite: 10_000, output: 3000 }));
  expect(row?.simulated).toEqual(row?.real);
});

it('sizes the summary only from compactions inside the window', () => {
  const file = session('a', [
    header(5),
    realCompaction('c0', 6, 'x'.repeat(40_000), { input: 90_000, output: 10_000 }),
    assistant('t1', 11, { cacheWrite: 10_000 }),
    realCompaction('c1', 12, 'x'.repeat(8000), { input: 40_000, output: 2000 }),
  ]);

  const report = compactionReplayReport([file], window, [1_000_000], 0);

  expect([report.summaryTokens, report.summarySamples]).toEqual([2000, 1]);
});

it('counts malformed lines and files without a session header', () => {
  const broken = session('a', [header(10), '{"type":', '[1]', JSON.stringify({ type: 'message' })]);
  const headless = session('b', [assistant('t1', 11, { cacheWrite: 10_000 })]);
  const report = compactionReplayReport([broken, headless], window, [150_000], 2);

  expect([report.malformedLines, report.unreadableFiles, rows(report)]).toEqual([3, 3, [[]]]);
});

it('lists the recall of each real compaction in the window', () => {
  const file = session('a', [
    header(10),
    JSON.stringify({
      type: 'message',
      id: 'u1',
      parentId: 's10',
      timestamp: minute(11),
      message: { role: 'user', content: 'Start ME-466.' },
    }),
    JSON.stringify({
      type: 'compaction',
      id: 'c1',
      parentId: 'u1',
      timestamp: minute(12),
      summary: '',
      firstKeptEntryId: 'c1',
      tokensBefore: 100,
    }),
    JSON.stringify({
      type: 'compaction',
      id: 'c2',
      parentId: 'c1',
      timestamp: minute(13),
      summary: '',
      firstKeptEntryId: 'gone',
      tokensBefore: 100,
    }),
    JSON.stringify({
      type: 'message',
      id: 'u2',
      parentId: 'c1',
      timestamp: minute(14),
      message: { role: 'user', content: 'ME-466 again.' },
    }),
  ]);

  const report = compactionReplayReport([file], window, [150_000], 0);

  expect(
    report.compactions.map((row) => [row.path, row.entryId, row.lost.map((fact) => fact.value)]),
  ).toEqual([['a', 'c1', ['ME-466']]]);

  expect(report.unmatchedCompactions).toBe(1);
});
