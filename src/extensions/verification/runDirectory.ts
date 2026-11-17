import { findSharedRepositoryRoot, findTauRoot } from '../../tauDirectory.js';
import { isRunName } from '../../verification/records.js';
import { runDirectoryPath } from '../../verification/verification.js';

export interface VerificationRoots {
  checkoutRoot: string;
  recordRoot: string;
}

export interface RunDirectory extends VerificationRoots {
  directory: string;
}

export const findVerificationRoots = async (
  cwd: string,
  toolName: string,
): Promise<VerificationRoots> => {
  const checkoutRoot = await findTauRoot(cwd, toolName);
  const recordRoot = await findSharedRepositoryRoot(cwd);

  return { checkoutRoot, recordRoot };
};

export const findRunDirectory = async (
  cwd: string,
  run: string,
  toolName: string,
): Promise<RunDirectory> => {
  if (!isRunName(run)) {
    throw new Error(`Run name ${run} is not a verification run name.`);
  }

  const { checkoutRoot, recordRoot } = await findVerificationRoots(cwd, toolName);

  return { checkoutRoot, recordRoot, directory: runDirectoryPath(recordRoot, run) };
};
