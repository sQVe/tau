import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { userConfigPath } from '../../src/config/config.ts';
import { readQuestionGateShadow, shadowCohort } from '../../src/config/questionGateModels.ts';
import { readShadowRecords } from '../../src/questionGate/questionGate.ts';
import { readVersionedRecord } from '../../src/record.ts';
import { findSharedRepositoryRoot, rejectTauSymlinks } from '../../src/tauDirectory.ts';
import { stderrConfigWarnings } from './configWarnings.ts';
import { formatShadowReport, shadowReport } from './shadowReport.ts';

const shadowSetting = 'questionGate.shadow';

export const runShadowReport = async (cwd: string): Promise<string> => {
  const agentDirectory = getAgentDir();
  const sharedRoot = await findSharedRepositoryRoot(cwd);
  const location = { cwd: sharedRoot, agentDirectory, projectTrusted: false };
  const config = readQuestionGateShadow(location, stderrConfigWarnings);

  if (config === undefined) {
    throw new Error(
      `Set ${shadowSetting} in ${userConfigPath(agentDirectory)} to score the frozen shadow candidate.`,
    );
  }

  const { shadow } = config;

  const directory = join(sharedRoot, '.tau', 'questions');

  await rejectTauSymlinks(sharedRoot, 'questions');

  const { records, gaps } = await readShadowRecords(directory, readVersionedRecord);
  const cohort = shadowCohort(config);

  const report = shadowReport({
    records,
    cohort,
    variant: shadow.variant,
    cutoff: shadow.cutoff,
  });

  const excluded = records.length - report.sampled;

  process.stderr.write(`Excluded ${excluded} shadow records from other cohorts.\n`);

  for (const gap of gaps) {
    process.stderr.write(`Shadow record warning: ${gap.reason}\n`);
  }

  return formatShadowReport(report);
};
