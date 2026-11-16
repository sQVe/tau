import { findTauRoot } from '../../tauDirectory.js';
import { isRunName } from '../../verification/records.js';
import { runDirectoryPath } from '../../verification/verification.js';

export const findRunDirectory = async (cwd: string, run: string): Promise<string> => {
  if (!isRunName(run)) {
    throw new Error(`Run name ${run} is not a verification run name.`);
  }

  return runDirectoryPath(await findTauRoot(cwd, 'verification_record'), run);
};
