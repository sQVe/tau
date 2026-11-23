import { expect, it } from 'vitest';

import type { SavedLog } from '../../../checkRecord/reuseDecision.js';
import { decideReportGate } from './reportGateDecision.js';

const argv = ['pnpm', 'check'];
const logPath = '/repository/.tau/checks/run.log';
const tree = 'tree-one';
const declaredFullCheck = { owner: 'AI-1688', reason: 'the module is not wired in yet' };

const savedLog = (
  passed: boolean,
  commandArguments: string[] = argv,
  overrides: Partial<SavedLog> = {},
): SavedLog => ({
  logPath,
  read: {
    status: 'valid',
    record: { version: 3, tree, argv: commandArguments, passed },
  },
  logExists: true,
  ...overrides,
});

const cited = (value: boolean) => ({
  summary: value ? `Done.\n\nEvidence: ${logPath}` : 'Done.\n\nEvidence: a reference',
  evidence: value ? [logPath] : ['a reference'],
});

const citedInSummaryOnly = {
  summary: `Done.\n\nEvidence: ${logPath}`,
  evidence: ['a reference'],
};

const noRecordMessage =
  'Report refused: no full check record for the current tree and command. Run full_check on the final tree, then report.';

it.each([
  {
    name: 'an undeclared passing record accepts',
    declaration: null,
    savedRecords: [savedLog(true)],
    configuredArgv: argv,
    citation: cited(false),
    expected: { status: 'accept', fullCheck: null },
  },
  {
    name: 'an undeclared failing record refuses',
    declaration: null,
    savedRecords: [savedLog(false)],
    configuredArgv: argv,
    citation: cited(false),
    expected: {
      status: 'refuse',
      message:
        'Report refused: no passing full check record for the current tree. Run full_check on the final tree, then report.',
    },
  },
  {
    name: 'an undeclared missing record refuses',
    declaration: null,
    savedRecords: [],
    configuredArgv: argv,
    citation: cited(false),
    expected: {
      status: 'refuse',
      message:
        'Report refused: no passing full check record for the current tree. Run full_check on the final tree, then report.',
    },
  },
  {
    name: 'an undeclared newer record of another command still refuses',
    declaration: null,
    savedRecords: [savedLog(true, ['pnpm', 'test']), savedLog(true)],
    configuredArgv: argv,
    citation: cited(false),
    expected: {
      status: 'refuse',
      message:
        'Report refused: no passing full check record for the current tree. Run full_check on the final tree, then report.',
    },
  },
  {
    name: 'a declared passing record with its citation accepts',
    declaration: declaredFullCheck,
    savedRecords: [savedLog(true)],
    configuredArgv: argv,
    citation: cited(true),
    expected: {
      status: 'accept',
      fullCheck: { owner: declaredFullCheck.owner, logPath, passed: true },
    },
  },
  {
    name: 'a declared failing record with its citation accepts',
    declaration: declaredFullCheck,
    savedRecords: [savedLog(false)],
    configuredArgv: argv,
    citation: cited(true),
    expected: {
      status: 'accept',
      fullCheck: { owner: declaredFullCheck.owner, logPath, passed: false },
    },
  },
  {
    name: 'a declared record cited only in the summary accepts',
    declaration: declaredFullCheck,
    savedRecords: [savedLog(false)],
    configuredArgv: argv,
    citation: citedInSummaryOnly,
    expected: {
      status: 'accept',
      fullCheck: { owner: declaredFullCheck.owner, logPath, passed: false },
    },
  },
  {
    name: 'a declared record without its citation refuses',
    declaration: declaredFullCheck,
    savedRecords: [savedLog(false)],
    configuredArgv: argv,
    citation: cited(false),
    expected: {
      status: 'refuse',
      message:
        'Report refused: the report does not cite the full check log for the current tree. Add its log path to evidence or summary, then report.',
    },
  },
  {
    name: 'a declared missing record refuses',
    declaration: declaredFullCheck,
    savedRecords: [],
    configuredArgv: argv,
    citation: cited(true),
    expected: { status: 'refuse', message: noRecordMessage },
  },
  {
    name: 'a declared report skips a newer record of another command',
    declaration: declaredFullCheck,
    savedRecords: [
      savedLog(true, ['pnpm', 'test'], { logPath: '/repository/.tau/checks/newer.log' }),
      savedLog(false),
    ],
    configuredArgv: argv,
    citation: cited(true),
    expected: {
      status: 'accept',
      fullCheck: { owner: declaredFullCheck.owner, logPath, passed: false },
    },
  },
  {
    name: 'a declared report with only another command refuses',
    declaration: declaredFullCheck,
    savedRecords: [savedLog(true, ['pnpm', 'test'])],
    configuredArgv: argv,
    citation: cited(true),
    expected: { status: 'refuse', message: noRecordMessage },
  },
  {
    name: 'no configured full check accepts an undeclared assignment',
    declaration: null,
    savedRecords: [],
    configuredArgv: undefined,
    citation: cited(false),
    expected: { status: 'accept', fullCheck: null },
  },
  {
    name: 'no configured full check refuses a declared assignment',
    declaration: declaredFullCheck,
    savedRecords: [],
    configuredArgv: undefined,
    citation: cited(false),
    expected: {
      status: 'refuse',
      message:
        'Report refused: this assignment declares fullCheck but no full check command is configured. Add fullCheck.argv to .pi/tau.json, then report.',
    },
  },
  {
    name: 'an investigation worker accepts without a record',
    role: 'investigation' as const,
    declaration: declaredFullCheck,
    savedRecords: [],
    configuredArgv: argv,
    citation: cited(false),
    expected: { status: 'accept', fullCheck: null },
  },
])(
  '$name',
  ({
    role = 'editing' as const,
    declaration,
    savedRecords,
    configuredArgv,
    citation,
    expected,
  }) => {
    expect(
      decideReportGate({
        role,
        tree,
        configuredArgv,
        declaration,
        savedRecords,
        summary: citation.summary,
        evidence: citation.evidence,
      }),
    ).toEqual(expected);
  },
);
