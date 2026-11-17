import { join } from 'node:path';

import { listSavedLogs } from '../../checkRecord/checkRecord.js';
import { readCheckIdentity } from '../../checkRecord/identity.js';
import { decideReuse } from '../../checkRecord/reuseDecision.js';

export interface ReportCheckFacts {
  role: 'editing' | 'investigation';
  root: string;
  argv: string[] | undefined;
}

export const checkRefusal = async (facts: ReportCheckFacts): Promise<string | undefined> => {
  if (facts.role !== 'editing') {
    return undefined;
  }

  if (facts.argv === undefined) {
    return undefined;
  }

  const identity = await readCheckIdentity(facts.root, facts.argv);
  const saved = await listSavedLogs(join(facts.root, '.tau/checks'));

  return decideReuse(identity, saved).status === 'reuse'
    ? undefined
    : 'Report refused: no passing full check record for the current tree. Run full_check on the final tree, then report.';
};
