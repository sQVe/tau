import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { hasErrorCode, isMissingFile } from '../../errors.js';
import { publishTextSync, recordText } from '../../record.js';
import { climbsOut, existingEntry } from '../../tauDirectory.js';
import { isItemName, itemRecordVersion } from '../../verification/records.js';
import type { ItemRecord } from '../../verification/records.js';
import {
  itemRecordPath,
  readRunRecord,
  runRecordPath,
  validateItemRecord,
} from '../../verification/verification.js';
import { decideItemWrite } from './itemDecision.js';
import type { ArtifactFact } from './itemDecision.js';
import type { RecordInput } from './recordParameters.js';
import { checkRecordDirectory, findRunDirectory } from './runDirectory.js';

// The mode writeFile gives a record, before the umask applies.
const itemRecordMode = 0o666;

const artifactLocation = async (
  directory: string,
  path: string,
): Promise<ArtifactFact['location']> => {
  if (climbsOut(path)) {
    return 'outside';
  }

  let real: string;

  try {
    real = await realpath(join(directory, path));
  } catch (error) {
    if (isMissingFile(error) || hasErrorCode(error, 'ENOTDIR')) {
      return 'missing';
    }

    return 'unreadable';
  }

  const realDirectory = await realpath(directory);
  const relativePath = relative(realDirectory, real);

  return climbsOut(relativePath) || isAbsolute(relativePath) ? 'outside' : 'inside';
};

const artifactFacts = async (
  directory: string,
  steps: RecordInput['steps'],
): Promise<ArtifactFact[]> =>
  Promise.all(
    steps.flatMap((step, index) =>
      step.artifacts.map(async (artifact) => ({
        step: index + 1,
        path: artifact.path,
        location: await artifactLocation(directory, artifact.path),
      })),
    ),
  );

export const recordItem = async (
  cwd: string,
  input: RecordInput,
): Promise<{ run: string; item: string; path: string }> => {
  const { recordRoot, directory } = await findRunDirectory(cwd, input.run, 'verification_record');
  const runRead = await readRunRecord(runRecordPath(directory));

  const itemFileExists = isItemName(input.item)
    ? (await existingEntry(itemRecordPath(directory, input.item))) !== undefined
    : false;

  const artifacts = await artifactFacts(directory, input.steps);

  const decision = decideItemWrite({
    run: input.run,
    runRead,
    item: input.item,
    steps: input.steps,
    endState: input.endState,
    itemFileExists,
    artifacts,
  });

  if (decision.kind === 'refuse') {
    throw new Error(decision.reason);
  }

  const path = itemRecordPath(directory, input.item);
  const record: ItemRecord = { version: itemRecordVersion, ...decision.record };

  validateItemRecord(path, record);

  await checkRecordDirectory(recordRoot, dirname(path));
  await mkdir(dirname(path), { recursive: true });

  try {
    publishTextSync(path, recordText(record), { mode: itemRecordMode });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error(
        `Item ${input.item} already has a result in run ${input.run}. Each item is recorded once.`,
        { cause: error },
      );
    }

    throw error;
  }

  return { run: input.run, item: input.item, path };
};
