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

const isValidLog = (log: SavedLog): log is ValidSavedLog =>
  log.logExists && log.read.status === 'valid';

const sameTree = (tree: string | null, log: ValidSavedLog): boolean =>
  tree !== null && log.read.record.tree === tree;

// Declared reports ignore a newer record of another command. Undeclared reports keep the newest
// tree record, so a newer record of another command still forces a fresh passing run.
const selectNewestRecord = (
  facts: Pick<ReportGateFacts, 'tree' | 'configuredArgv' | 'declaration' | 'savedRecords'>,
): ValidSavedLog | undefined => {
  const candidates = facts.savedRecords.filter(
    (log): log is ValidSavedLog => isValidLog(log) && sameTree(facts.tree, log),
  );

  if (facts.declaration === null) {
    return candidates[0];
  }

  const argv = facts.configuredArgv ?? [];

  return candidates.find((log) => sameArgv(argv, log.read.record.argv));
};

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

  const record = selectNewestRecord(facts);

  if (facts.declaration === null) {
    const passing =
      record !== undefined &&
      sameArgv(configuredArgv, record.read.record.argv) &&
      record.read.record.passed;

    return passing
      ? { status: 'accept', fullCheck: null }
      : { status: 'refuse', message: noPassingRecord };
  }

  if (record === undefined) {
    return { status: 'refuse', message: noRecord };
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
