import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { userConfigPath } from '../../src/config/config.ts';
import { readQuestionGateConfig, shadowCohort } from '../../src/config/questionGateModels.ts';
import { readShadowRecords } from '../../src/questionGate/questionGate.ts';
import { readVersionedRecord } from '../../src/record.ts';
import { findSharedRepositoryRoot, rejectTauSymlinks } from '../../src/tauDirectory.ts';
import { formatShadowReport, shadowReport } from './shadowReport.ts';

const shadowSetting = 'questionGate.shadow';

export const runShadowReport = async (cwd: string): Promise<string> => {
  const agentDirectory = getAgentDir();
  const sharedRoot = await findSharedRepositoryRoot(cwd);
  const location = { cwd: sharedRoot, agentDirectory, projectTrusted: false };
  const config = readQuestionGateConfig(location);
  const shadow = config?.shadow;

  if (config === undefined || shadow === undefined) {
    throw new Error(
      `Set ${shadowSetting} in ${userConfigPath(agentDirectory)} to score the frozen shadow candidate.`,
    );
  }

  const directory = join(sharedRoot, '.tau', 'questions');

  await rejectTauSymlinks(sharedRoot, 'questions');

  const { records, gaps } = await readShadowRecords(directory, readVersionedRecord);
  const cohort = shadowCohort({ ...config, shadow });
  const excluded = records.filter((record) => record.cohort !== cohort).length;

  process.stderr.write(`Excluded ${excluded} shadow records from other cohorts.\n`);

  for (const gap of gaps) {
    process.stderr.write(`Shadow record warning: ${gap.reason}\n`);
  }

  return formatShadowReport(
    shadowReport({ records, cohort, variant: shadow.variant, cutoff: shadow.cutoff }),
  );
};
