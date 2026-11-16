import { findTauRoot } from '../../tauDirectory.js';
import { isRunName } from '../../verification/records.js';
import { runDirectoryPath } from '../../verification/verification.js';

export interface RunDirectory {
  root: string;
  directory: string;
}

export const findVerificationRoot = (cwd: string, toolName: string): Promise<string> =>
  findTauRoot(cwd, toolName);

export const findRunDirectory = async (
  cwd: string,
  run: string,
  toolName: string,
): Promise<RunDirectory> => {
  if (!isRunName(run)) {
    throw new Error(`Run name ${run} is not a verification run name.`);
  }

  const root = await findVerificationRoot(cwd, toolName);

  return { root, directory: runDirectoryPath(root, run) };
};
