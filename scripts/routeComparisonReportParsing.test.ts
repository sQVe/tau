import { describe, expect, it } from 'vitest';

import { before } from './fixtures/routeComparisonTimes.js';
import { parseRouteRecord, reportTimeFromSession } from './routeComparisonReport.js';
import type { RecordFile, RecordKind } from './routeComparisonReport.js';

const taskFile = (
  kind: RecordKind,
  version: number,
  extra: Record<string, unknown> = {},
): RecordFile => ({
  kind,
  text: JSON.stringify({
    version,
    taskId: 't',
    createdAt: before,
    loadout: { profile: 'worker', model: 'model-a', cwd: '/repo' },
    ...extra,
  }),
});

const assignmentFile = (version: number): RecordFile => ({
  kind: 'assignment',
  text: JSON.stringify({ version, assignmentId: 'a', createdAt: before }),
});

const recordFile = (
  kind: RecordKind,
  fields: Record<string, unknown>,
  reportText?: string,
): RecordFile => ({
  kind,
  text: JSON.stringify(fields),
  ...(reportText === undefined ? {} : { reportText }),
});

const taskFields = (extra: Record<string, unknown> = {}) => ({
  taskId: 't',
  createdAt: before,
  predecessorTaskId: 'task-parent',
  previousAssignmentId: 'assignment-parent',
  loadout: { profile: 'worker' },
  ...extra,
});

const sessionMessage = (
  toolName: string,
  isError: boolean,
  timestamp: string,
  role = 'toolResult',
) => JSON.stringify({ type: 'message', timestamp, message: { role, toolName, isError } });

describe('parseRouteRecord', () => {
  it.each([
    { rule: 'an archive version 8 record', file: taskFile('archive', 8), kind: 'record' },
    { rule: 'an archive version 9 record', file: taskFile('archive', 9), kind: 'record' },
    { rule: 'an archive version 11 record', file: taskFile('archive', 11), kind: 'record' },
    { rule: 'a worker version 11 record', file: taskFile('worker', 11), kind: 'record' },
    { rule: 'a worker version 13 record', file: taskFile('worker', 13), kind: 'record' },
    { rule: 'an assignment version 3 record', file: assignmentFile(3), kind: 'record' },
    { rule: 'an archive version 7 record', file: taskFile('archive', 7), kind: 'pre-routing' },
    { rule: 'a worker version 6 record', file: taskFile('worker', 6), kind: 'pre-routing' },
    { rule: 'an archive version 10 record', file: taskFile('archive', 10), kind: 'skipped' },
    { rule: 'a worker version 12 record', file: taskFile('worker', 12), kind: 'skipped' },
    { rule: 'an assignment version 2 record', file: assignmentFile(2), kind: 'skipped' },
    {
      rule: 'an unparsable record',
      file: { kind: 'archive' as const, text: '{ not json' },
      kind: 'skipped',
    },
    { rule: 'a JSON scalar', file: { kind: 'archive' as const, text: '42' }, kind: 'skipped' },
  ])('$rule parses as $kind', ({ file, kind }) => {
    expect(parseRouteRecord(file).kind).toBe(kind);
  });

  it.each([
    {
      rule: 'an archive task record',
      file: recordFile(
        'archive',
        { version: 8, ...taskFields() },
        JSON.stringify({ outcome: 'success' }),
      ),
      link: 'task-parent',
      outcome: 'success',
    },
    {
      rule: 'a worker task record',
      file: recordFile(
        'worker',
        { version: 13, ...taskFields() },
        JSON.stringify({ outcome: 'failure' }),
      ),
      link: 'task-parent',
      outcome: 'failure',
    },
    {
      rule: 'an assignment record',
      file: recordFile(
        'assignment',
        {
          version: 3,
          assignmentId: 'a',
          createdAt: before,
          predecessorTaskId: 'task-parent',
          previousAssignmentId: 'assignment-parent',
          report: { outcome: 'incomplete' },
        },
        JSON.stringify({ outcome: 'success' }),
      ),
      link: 'assignment-parent',
      outcome: 'incomplete',
    },
  ])('$rule reads its follow-up link and report outcome', ({ file, link, outcome }) => {
    const result = parseRouteRecord(file);

    expect(result.kind).toBe('record');

    if (result.kind !== 'record') {
      throw new Error('expected a record');
    }

    expect(result.record.predecessorId).toBe(link);
    expect(result.record.outcome).toBe(outcome);
  });

  it('reads the version 3 report time from the session file', () => {
    const text = JSON.stringify({
      version: 3,
      assignmentId: 'a',
      createdAt: before,
      routing: { label: 'routine' },
      session: { file: '/worker.jsonl' },
    });

    const sessionText = [
      sessionMessage('subagent_report', true, '2026-11-01T00:01:00Z'),
      sessionMessage('bash', false, '2026-11-01T00:02:00Z'),
      sessionMessage('subagent_report', false, '2026-11-01T00:03:00Z'),
    ].join('\n');

    const result = parseRouteRecord({ kind: 'assignment', text, sessionText });

    expect(result.kind).toBe('record');

    if (result.kind !== 'record') {
      throw new Error('expected a record');
    }

    expect(result.record.reportTime).toBe(Date.parse('2026-11-01T00:03:00Z'));
  });
});

describe('reportTimeFromSession', () => {
  it.each([
    {
      rule: 'the first successful subagent report',
      source: [
        sessionMessage('subagent_report', true, '2026-11-01T00:01:00Z'),
        sessionMessage('subagent_report', false, '2026-11-01T00:02:00Z'),
        sessionMessage('subagent_report', false, '2026-11-01T00:03:00Z'),
      ].join('\n'),
      time: Date.parse('2026-11-01T00:02:00Z'),
    },
    {
      rule: 'a report after a malformed line',
      source: ['{ broken', sessionMessage('subagent_report', false, '2026-11-01T00:02:00Z')].join(
        '\n',
      ),
      time: Date.parse('2026-11-01T00:02:00Z'),
    },
    {
      rule: 'no successful report',
      source: sessionMessage('subagent_report', true, '2026-11-01T00:01:00Z'),
      time: undefined,
    },
    {
      rule: 'a report from another tool',
      source: sessionMessage('bash', false, '2026-11-01T00:01:00Z'),
      time: undefined,
    },
    {
      rule: 'a user message that names the tool',
      source: sessionMessage('subagent_report', false, '2026-11-01T00:01:00Z', 'user'),
      time: undefined,
    },
  ])('returns $time for $rule', ({ source, time }) => {
    expect(reportTimeFromSession(source)).toBe(time);
  });
});
