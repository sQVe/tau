import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { findTauRoot } from '../../tauDirectory.js';
import { isRunName } from '../../verification/records.js';
import { runDirectoryPath } from '../../verification/verification.js';
import { isWorkerProcess } from '../../worker.js';
import { createVerificationTool } from './tool.js';

export interface RunDirectory {
  root: string;
  directory: string;
}

export const findRunDirectory = async (cwd: string, run: string): Promise<RunDirectory> => {
  if (!isRunName(run)) {
    throw new Error(`Run name ${run} is not a verification run name.`);
  }

  const root = await findTauRoot(cwd, 'verification_record');

  return { root, directory: runDirectoryPath(root, run) };
};

export default function verificationExtension(pi: ExtensionAPI): void {
  if (isWorkerProcess()) {
    return;
  }

  pi.registerTool(createVerificationTool());
}
