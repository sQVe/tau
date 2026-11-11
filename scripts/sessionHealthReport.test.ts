import { describe, expect, it } from 'vitest';

import {
  collectSessionFile,
  createHealthCollection,
  formatSessionHealthReport,
  sessionHealthReport,
} from './sessionHealthReport.js';
import type { HealthRule, SessionFile, Side, ToolDay } from './sessionHealthReport.js';

const at = (day: number, hour = 10) =>
  `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

const window = { since: Date.parse(at(2, 0)), until: Date.parse(at(5, 0)) };

let entryNumber = 0;

const entry = (timestamp: string, fields: Record<string, unknown>) => {
  entryNumber += 1;

  return JSON.stringify({ type: 'message', id: `e${entryNumber}`, timestamp, ...fields });
};

const header = (timestamp: string) => JSON.stringify({ type: 'session', id: 's', timestamp });

const toolCall = (timestamp: string, id: string, name: string, args: unknown = {}) =>
  entry(timestamp, {
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] },
  });

const toolResult = (
  timestamp: string,
  id: string,
  result: { error?: string; details?: unknown } = {},
) =>
  entry(timestamp, {
    message: {
      role: 'toolResult',
      toolCallId: id,
      isError: result.error !== undefined,
      content: [{ type: 'text', text: result.error ?? 'done' }],
      details: result.details,
    },
  });

const session = (lines: string[], side: Side = 'manager'): SessionFile => ({
  path: `/${side}.jsonl`,
  side,
  text: `${[header(at(1)), ...lines].join('\n')}\n`,
});

const report = (files: SessionFile[], rules: HealthRule[] = []) => {
  const collection = createHealthCollection(window);

  for (const file of files) {
    collectSessionFile(collection, file);
  }

  return sessionHealthReport(collection, { rules, unreadableFiles: 0 });
};

const rows = (files: SessionFile[], rules: HealthRule[] = []) =>
  report(files, rules).days.map((row) => ({
    day: row.day,
    tool: row.tool,
    calls: row.calls,
    codemodeCalls: row.codemodeCalls,
    errors: row.errors,
  }));

const row = (day: string, tool: string, counts: Partial<ToolDay> = {}) => ({
  day,
  tool,
  calls: 1,
  codemodeCalls: 0,
  errors: 0,
  ...counts,
});

describe('sessionHealthReport', () => {
  it.each([
    {
      name: 'counts a direct call and its error by UTC day',
      lines: [
        toolCall(at(2, 23), 'a', 'bash'),
        toolResult(at(3, 0), 'a', { error: 'exit 1' }),
        toolCall(at(3), 'b', 'bash'),
        toolResult(at(3), 'b'),
      ],
      expected: [row('2026-10-02', 'bash', { errors: 1 }), row('2026-10-03', 'bash')],
    },
    {
      name: 'counts the calls of a codemode script under their own tools',
      lines: [
        toolCall(at(2), 'a', 'codemode'),
        toolResult(at(2), 'a', {
          details: {
            calls: [
              { name: 'read', args: '{"path":"x"}', status: 'ok' },
              { name: 'write', args: '{"path":', status: 'error', error: 'refused' },
            ],
          },
        }),
      ],
      expected: [
        row('2026-10-02', 'codemode'),
        row('2026-10-02', 'read', { codemodeCalls: 1 }),
        row('2026-10-02', 'write', { codemodeCalls: 1, errors: 1 }),
      ],
    },
    {
      name: 'skips codemode calls without a tool name',
      lines: [
        toolCall(at(2), 'a', 'codemode'),
        toolResult(at(2), 'a', { details: { calls: [{ status: 'ok' }, 'read'] } }),
      ],
      expected: [row('2026-10-02', 'codemode')],
    },
    {
      name: 'counts a call without a result and no error',
      lines: [toolCall(at(2), 'a', 'bash')],
      expected: [row('2026-10-02', 'bash')],
    },
    {
      name: 'skips calls outside the window and results of calls before it',
      lines: [
        toolCall(at(1), 'a', 'bash'),
        toolResult(at(2), 'a', { error: 'late' }),
        toolCall(at(5), 'b', 'bash'),
      ],
      expected: [],
    },
  ])('$name', ({ lines, expected }) => {
    expect(rows([session(lines)])).toEqual(expected);
  });

  it('counts codemode calls on the day the script started', () => {
    const lines = [
      toolCall(at(2, 23), 'a', 'codemode'),
      toolResult(at(3, 0), 'a', { details: { calls: [{ name: 'read', status: 'ok' }] } }),
    ];

    expect(rows([session(lines)])).toEqual([
      row('2026-10-02', 'codemode'),
      row('2026-10-02', 'read', { codemodeCalls: 1 }),
    ]);
  });

  it('counts an entry that a later session copied once', () => {
    const call = toolCall(at(2), 'a', 'bash');
    const original = session([call]);
    const copy = { ...session([call], 'worker'), path: '/copy.jsonl' };

    const result = report([original, copy]);

    expect(result.days.map((day) => [day.tool, day.calls])).toEqual([['bash', 1]]);
    expect(result.copiedEntries).toBe(1);
    expect([result.managerFiles, result.workerFiles]).toEqual([1, 1]);
  });

  it('skips malformed lines and entries without a timestamp', () => {
    const result = report([session(['{not json', '[1]', JSON.stringify({ type: 'message' })])]);

    expect(result.malformedLines).toBe(3);
    expect(result.days).toEqual([]);
  });

  it('lists the three most frequent errors with their numbers folded', () => {
    const errors = ['has 3,488 characters', 'has 3,051 characters', 'b', 'c', 'c', 'd'];

    const lines = errors.flatMap((error, index) => [
      toolCall(at(2), `c${index}`, 'subagent_report'),
      toolResult(at(2), `c${index}`, { error }),
    ]);

    const [day] = report([session(lines)]).days;

    expect(day?.topErrors).toEqual([
      { message: 'c', count: 2 },
      { message: 'has N characters', count: 2 },
      { message: 'b', count: 1 },
    ]);
  });

  it('runs each rule on the calls of its tool for every day, also without calls', () => {
    const seen: [string, string[]][] = [];

    const rule: HealthRule = {
      tool: 'run_tests',
      name: 'fresh',
      check: (calls, day) => {
        seen.push([day, calls.map((call) => String(call.details?.freshness))]);

        return calls.length === 0 ? 'not called' : undefined;
      },
    };

    const lines = [
      toolCall(at(2), 'a', 'run_tests'),
      toolResult(at(2), 'a', { details: { freshness: 'fresh' } }),
      toolCall(at(3), 'b', 'bash'),
    ];

    const result = report([session(lines)], [rule]);

    expect(seen).toEqual([
      ['2026-10-02', ['fresh']],
      ['2026-10-03', []],
    ]);

    expect(result.days.map((day) => [day.day, day.tool, day.rules])).toEqual([
      ['2026-10-02', 'run_tests', [{ name: 'fresh', failure: undefined }]],
      ['2026-10-03', 'bash', []],
      ['2026-10-03', 'run_tests', [{ name: 'fresh', failure: 'not called' }]],
    ]);
  });
});

describe('formatSessionHealthReport', () => {
  it('lists failed rules first, then each day with its tools and top errors', () => {
    const rule: HealthRule = { tool: 'bash', name: 'quiet', check: () => 'too loud' };

    const lines = [toolCall(at(2), 'a', 'bash'), toolResult(at(2), 'a', { error: 'exit 1' })];
    const text = formatSessionHealthReport(report([session(lines)], [rule]));

    const failed = text.indexOf('2026-10-02  bash quiet: too loud');
    const day = text.indexOf('\n2026-10-02\n');

    expect(failed).toBeGreaterThan(-1);
    expect(day).toBeGreaterThan(failed);
    expect(text).toMatch(/bash\s+1\s+0\s+1\s+100%\s+fail: quiet\n {4}1x exit N\n/);
  });

  it('says so when every rule holds', () => {
    const text = formatSessionHealthReport(report([]));

    expect(text).toContain('Failed rules\nNone\n');
  });
});
