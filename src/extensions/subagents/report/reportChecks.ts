import { join } from 'node:path';

import { listSavedLogs } from '../../../checkRecord/checkRecord.js';
import { readCheckIdentity } from '../../../checkRecord/identity.js';
import type { Assignment } from '../assignment.js';
import { decideReportGate } from './reportGateDecision.js';
import type { ReportGateDecision } from './reportGateDecision.js';

export interface ReportCheckFacts {
  role: 'editing' | 'investigation';
  root: string;
  argv: string[] | undefined;
  fullCheck: Assignment['fullCheck'];
  summary: string;
  evidence: readonly string[];
}

export const checkReport = async (facts: ReportCheckFacts): Promise<ReportGateDecision> => {
  if (facts.role !== 'editing' || facts.argv === undefined) {
    return decideReportGate({
      role: facts.role,
      tree: null,
      configuredArgv: facts.argv,
      declaration: facts.fullCheck,
      savedRecords: [],
      summary: facts.summary,
      evidence: facts.evidence,
    });
  }

  const identity = await readCheckIdentity(facts.root, facts.argv);
  const savedRecords = await listSavedLogs(join(facts.root, '.tau/checks'));

  return decideReportGate({
    role: facts.role,
    tree: identity.tree,
    configuredArgv: facts.argv,
    declaration: facts.fullCheck,
    savedRecords,
    summary: facts.summary,
    evidence: facts.evidence,
  });
};
