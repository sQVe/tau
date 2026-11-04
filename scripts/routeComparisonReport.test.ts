import { describe, expect, it } from 'vitest';

import {
  parseRouteRecord,
  reportTimeFromSession,
  routeComparisonReport,
} from './routeComparisonReport.js';
import type {
  ComparisonOptions,
  ParsedRecord,
  RecordFile,
  RecordKind,
  RouteRecord,
} from './routeComparisonReport.js';

const switchTime = Date.parse('2026-11-01T00:00:00Z');
const before = switchTime - 60_000;
const after = switchTime + 60_000;

const options: ComparisonOptions = { profile: 'worker', label: 'routine', switch: switchTime };

const parsed = (fields: Partial<RouteRecord> & { id: string }): ParsedRecord => ({
  kind: 'record',
  record: {
    createdAt: before,
    profile: 'worker',
    label: 'routine',
    model: 'model-a',
    cwd: '/repo',
    parentSession: '/session.jsonl',
    ...fields,
  },
});

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

describe('routeComparisonReport', () => {
  it('counts one launch per side and a follow-up toward its launch', () => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'before-launch' }),
        parsed({ id: 'after-launch', createdAt: after }),
        parsed({ id: 'low-confidence', fallbackReason: 'lowConfidence' }),
        parsed({ id: 'follow-up', predecessorId: 'before-launch' }),
      ],
      options,
    );

    expect(report.before.launches.map((launch) => launch.id)).toEqual(['before-launch']);
    expect(report.after.launches.map((launch) => launch.id)).toEqual(['after-launch']);
    expect(report.before.followUps.total).toBe(1);
  });

  it.each([
    { rule: 'before the switch', createdAt: before, side: 'before' },
    { rule: 'on the switch', createdAt: switchTime, side: 'after' },
    { rule: 'after the switch', createdAt: after, side: 'after' },
  ])('puts a launch $rule on the $side side', ({ createdAt, side }) => {
    const report = routeComparisonReport([parsed({ id: 'launch', createdAt })], options);

    expect(report.before.launchCount).toBe(side === 'before' ? 1 : 0);
    expect(report.after.launchCount).toBe(side === 'after' ? 1 : 0);
  });

  it.each([
    {
      rule: 'a launch exactly at --since',
      since: before + 10,
      createdAt: before + 10,
      launches: 1,
    },
    {
      rule: 'a launch before --since',
      since: before + 10,
      createdAt: before + 9,
      launches: 0,
    },
  ])('counts $launches before-side launches for $rule', ({ since, createdAt, launches }) => {
    const report = routeComparisonReport([parsed({ id: 'launch', createdAt })], {
      ...options,
      since,
    });

    expect(report.before.launchCount).toBe(launches);
  });

  it.each([
    {
      rule: 'a launch before --until',
      until: after + 10,
      createdAt: after + 9,
      launches: 1,
    },
    {
      rule: 'a launch exactly at --until',
      until: after + 10,
      createdAt: after + 10,
      launches: 0,
    },
  ])('counts $launches after-side launches for $rule', ({ until, createdAt, launches }) => {
    const report = routeComparisonReport([parsed({ id: 'launch', createdAt })], {
      ...options,
      until,
    });

    expect(report.after.launchCount).toBe(launches);
  });

  it.each([
    { rule: '19 launches', count: 19, underTwenty: true },
    { rule: '20 launches', count: 20, underTwenty: false },
  ])('marks $rule as underTwenty $underTwenty', ({ count, underTwenty }) => {
    const launches = Array.from({ length: count }, (_, index) => parsed({ id: `launch-${index}` }));

    const report = routeComparisonReport(launches, options);

    expect(report.before.underTwenty).toBe(underTwenty);
  });

  it('filters the after side by model and leaves the before side whole', () => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'before-model-a', model: 'model-a' }),
        parsed({ id: 'before-model-b', model: 'model-b' }),
        parsed({ id: 'after-model-a', createdAt: after, model: 'model-a' }),
        parsed({ id: 'after-model-b', createdAt: after, model: 'model-b' }),
      ],
      { ...options, model: 'model-b' },
    );

    expect(report.before.launches.map((launch) => launch.id)).toEqual([
      'before-model-a',
      'before-model-b',
    ]);

    expect(report.after.launches.map((launch) => launch.id)).toEqual(['after-model-b']);
  });

  it.each([
    { rule: 'a confident launch', fields: {}, launch: true },
    { rule: 'a low-confidence record', fields: { fallbackReason: 'lowConfidence' }, launch: false },
    { rule: 'a follow-up record', fields: { predecessorId: 'source' }, launch: false },
    { rule: 'another label', fields: { label: 'hard' }, launch: false },
    { rule: 'another profile', fields: { profile: 'reviewer' }, launch: false },
  ])('excludes $rule from launches when $launch is false', ({ fields, launch }) => {
    const report = routeComparisonReport([parsed({ id: 'x', ...fields })], options);

    expect(report.before.launchCount).toBe(launch ? 1 : 0);
  });

  it('counts a follow-up through a chain of two toward its launch', () => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'launch' }),
        parsed({ id: 'first', predecessorId: 'launch', createdAt: before + 1 }),
        parsed({ id: 'second', predecessorId: 'first', createdAt: before + 2 }),
        parsed({ id: 'lone-launch', createdAt: before + 3 }),
      ],
      options,
    );

    expect(report.before.followUps).toEqual({ total: 2, mean: 1, withFollowUp: 1, share: 0.5 });
    expect(report.after.followUps).toEqual({ total: 0, mean: 0, withFollowUp: 0, share: 0 });
  });

  it.each([
    { rule: 'the same session and cwd', session: '/session.jsonl', cwd: '/repo', linked: 1 },
    { rule: 'a different session', session: '/other.jsonl', cwd: '/repo', linked: 0 },
    { rule: 'a different cwd', session: '/session.jsonl', cwd: '/other', linked: 0 },
  ])('links a reviewer in $rule', ({ session, cwd, linked }) => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'launch' }),
        parsed({
          id: 'review',
          profile: 'reviewer',
          label: 'hard',
          parentSession: session,
          cwd,
          createdAt: before + 1,
          outcome: 'success',
          summary: 'Fixed the bug',
        }),
      ],
      options,
    );

    expect(report.before.reviews.withLinkedReview).toBe(linked);
    expect(report.before.reviews.withFindings).toBe(linked);
  });

  it('links the earliest clean reviewer and ignores a later review with findings', () => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'launch' }),
        parsed({
          id: 'review-late',
          profile: 'reviewer',
          createdAt: before + 2,
          outcome: 'success',
          summary: 'Found another bug',
        }),
        parsed({
          id: 'review-early',
          profile: 'reviewer',
          createdAt: before + 1,
          outcome: 'success',
          summary: 'No findings in this change.',
        }),
        parsed({ id: 'next-launch', createdAt: before + 3 }),
      ],
      options,
    );

    expect(report.before.reviews.withLinkedReview).toBe(1);
    expect(report.before.reviews.withFindings).toBe(0);
    expect(report.before.reviews.share).toBe(0);
  });

  it('leaves a reviewer after the next launch out of the earlier launch', () => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'launch' }),
        parsed({ id: 'next-launch', createdAt: before + 1 }),
        parsed({
          id: 'review-after-next',
          profile: 'reviewer',
          createdAt: before + 2,
          outcome: 'success',
          summary: 'Fixed the bug',
        }),
      ],
      options,
    );

    expect(report.before.reviews.withLinkedReview).toBe(1);
  });

  it.each([
    { rule: 'no findings', summary: 'No findings in this change.', findings: 0 },
    { rule: 'no new findings', summary: 'No new findings.', findings: 0 },
    { rule: 'found no', summary: 'I found no defects here', findings: 0 },
    { rule: 'no defects', summary: 'There are no defects', findings: 0 },
    { rule: 'findings on the first line', summary: 'There is a bug', findings: 1 },
    { rule: 'a phrase after the first line', summary: 'There is a bug\nNo findings', findings: 1 },
  ])('counts $rule as $findings finding', ({ summary, findings }) => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'launch' }),
        parsed({
          id: 'review',
          profile: 'reviewer',
          createdAt: before + 1,
          outcome: 'success',
          summary,
        }),
      ],
      options,
    );

    expect(report.before.reviews.withFindings).toBe(findings);
  });

  it('counts a linked review with no report apart and leaves it out of the share', () => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'launch' }),
        parsed({ id: 'review', profile: 'reviewer', createdAt: before + 1 }),
      ],
      options,
    );

    expect(report.before.reviews.withLinkedReview).toBe(1);
    expect(report.before.reviews.withoutReport).toBe(1);
    expect(report.before.reviews.share).toBeUndefined();
  });

  it('reads success from the last record in the follow-up chain', () => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'launch', outcome: 'failure', summary: 'failed' }),
        parsed({
          id: 'first',
          predecessorId: 'launch',
          createdAt: before + 1,
          outcome: 'failure',
          summary: 'failed again',
        }),
        parsed({
          id: 'second',
          predecessorId: 'first',
          createdAt: before + 2,
          outcome: 'success',
          summary: 'done',
        }),
      ],
      options,
    );

    expect(report.before.success.success).toBe(1);
    expect(report.before.success.failure).toBe(0);
    expect(report.before.success.share).toBe(1);
  });

  it('counts a launch whose last record has no report as no report', () => {
    const report = routeComparisonReport([parsed({ id: 'launch' })], options);

    expect(report.before.success.withoutReport).toBe(1);
    expect(report.before.success.success).toBe(0);
    expect(report.before.success.share).toBe(0);
  });

  it('measures time to first report and leaves out launches without a report time', () => {
    const report = routeComparisonReport(
      [
        parsed({ id: 'reported', reportTime: before + 120_000 }),
        parsed({ id: 'missing', createdAt: before + 1 }),
      ],
      options,
    );

    expect(report.before.firstReport.measured).toBe(1);
    expect(report.before.firstReport.missing).toBe(1);
    expect(report.before.firstReport.medianMinutes).toBe(2);
  });

  it('counts unparsable and unknown-version records as skipped and old versions apart', () => {
    const files: RecordFile[] = [
      { kind: 'archive', text: '{ not json' },
      { kind: 'archive', text: JSON.stringify({ version: 10, taskId: 't', createdAt: before }) },
      { kind: 'archive', text: JSON.stringify({ version: 7, taskId: 'old', createdAt: before }) },
    ];

    const report = routeComparisonReport(files.map(parseRouteRecord), options);

    expect(report.skipped).toBe(2);
    expect(report.preRouting).toBe(1);
  });

  it('drops a duplicate id', () => {
    const report = routeComparisonReport(
      [parsed({ id: 'same' }), parsed({ id: 'same', createdAt: after })],
      options,
    );

    expect(report.before.launchCount).toBe(1);
    expect(report.after.launchCount).toBe(0);
    expect(report.duplicateIds).toBe(1);
  });
});
