import type { CheckRecord } from '../../../checkRecord/checkRecord.js';
import { sameArgv } from '../../../checkRecord/reuseDecision.js';
import type { SavedLog } from '../../../checkRecord/reuseDecision.js';

export interface ReportGateFacts {
  role: 'editing' | 'investigation';
  tree: string | null;
  configuredArgv: string[] | undefined;
  declaration: { owner: string; reason: string } | null;
  savedRecords: readonly SavedLog[];
  summary: string;
  evidence: readonly string[];
}

export type ReportGateDecision =
  | {
      status: 'accept';
      fullCheck: { owner: string; logPath: string; passed: boolean } | null;
    }
  | { status: 'refuse'; message: string };

interface ValidSavedLog extends SavedLog {
  read: { status: 'valid'; record: CheckRecord };
}

const noPassingRecord =
  'Report refused: no passing full check record for the current tree. Run full_check on the final tree, then report.';

const noRecord =
  'Report refused: no full check record for the current tree and command. Run full_check on the final tree, then report.';

const noCitation =
  'Report refused: the report does not cite the full check log for the current tree. Add its log path to evidence or summary, then report.';

const noCommand =
  'Report refused: this assignment declares fullCheck but no full check command is configured. Add fullCheck.argv to .pi/tau.json, then report.';

const noLog =
  'Report refused: the newest full check record for the current tree and command has no log. Run full_check again on the final tree, then report.';

const isValidLog = (log: SavedLog): log is ValidSavedLog =>
  log.logExists && log.read.status === 'valid';

const hasValidRead = (log: SavedLog): log is ValidSavedLog => log.read.status === 'valid';

const sameTree = (tree: string | null, log: ValidSavedLog): boolean =>
  tree !== null && log.read.record.tree === tree;

// Declared reports ignore a newer record of another command, so the newest record of the tree and
// command decides. A missing log then refuses, instead of falling back to an older record.
const selectNewestRecord = (
  facts: Pick<ReportGateFacts, 'tree' | 'savedRecords'>,
  argv: string[],
): ValidSavedLog | undefined =>
  facts.savedRecords.find(
    (log): log is ValidSavedLog =>
      hasValidRead(log) && sameTree(facts.tree, log) && sameArgv(argv, log.read.record.argv),
  );

// Undeclared reports keep the newest tree record with an existing log, so a newer record of another
// command still forces a fresh passing run.
const selectNewestLogRecord = (
  facts: Pick<ReportGateFacts, 'tree' | 'savedRecords'>,
): ValidSavedLog | undefined =>
  facts.savedRecords.find(
    (log): log is ValidSavedLog => isValidLog(log) && sameTree(facts.tree, log),
  );

const citesLogPath = (summary: string, evidence: readonly string[], logPath: string): boolean =>
  summary.includes(logPath) || evidence.some((item) => item.includes(logPath));

export const decideReportGate = (facts: ReportGateFacts): ReportGateDecision => {
  if (facts.role !== 'editing') {
    return { status: 'accept', fullCheck: null };
  }

  const configuredArgv = facts.configuredArgv;

  if (configuredArgv === undefined) {
    return facts.declaration === null
      ? { status: 'accept', fullCheck: null }
      : { status: 'refuse', message: noCommand };
  }

  if (facts.declaration === null) {
    const record = selectNewestLogRecord(facts);

    const passing =
      record !== undefined &&
      sameArgv(configuredArgv, record.read.record.argv) &&
      record.read.record.passed;

    return passing
      ? { status: 'accept', fullCheck: null }
      : { status: 'refuse', message: noPassingRecord };
  }

  const record = selectNewestRecord(facts, configuredArgv);

  if (record === undefined) {
    return { status: 'refuse', message: noRecord };
  }

  if (!record.logExists) {
    return { status: 'refuse', message: noLog };
  }

  if (!citesLogPath(facts.summary, facts.evidence, record.logPath)) {
    return { status: 'refuse', message: noCitation };
  }

  return {
    status: 'accept',
    fullCheck: {
      owner: facts.declaration.owner,
      logPath: record.logPath,
      passed: record.read.record.passed,
    },
  };
};
