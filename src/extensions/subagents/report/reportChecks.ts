import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { listSavedLogs } from '../../../checkRecord/checkRecord.js';
import { readCheckIdentity } from '../../../checkRecord/identity.js';
import { hasErrorCode, isMissingFile } from '../../../errors.js';
import type { Assignment } from '../assignment.js';
import { hasAppUrlLine } from '../launchEnvironment.js';
import { parsePageInventory } from './pageInventory/pageInventory.js';
import {
  appliesPageInventoryGate,
  decidePageInventoryGate,
} from './pageInventory/pageInventoryDecision.js';
import type { PageInventoryRead } from './pageInventory/pageInventoryDecision.js';
import { inventoryFileName } from './pageInventory/pageInventoryRefusal.js';
import { decideReportGate } from './reportGateDecision.js';
import type { ReportGateDecision } from './reportGateDecision.js';

export interface ReportCheckFacts {
  role: 'editing' | 'investigation';
  profile: string;
  task: string;
  assignmentDirectory: string;
  root: string;
  argv: string[] | undefined;
  fullCheck: Assignment['fullCheck'];
  summary: string;
  evidence: readonly string[];
}

interface PageInventoryFile {
  path: string;
  read: PageInventoryRead;
}

const unreadableInventoryCodes = ['EACCES', 'EISDIR', 'ELOOP', 'EPERM', 'EBUSY'] as const;
const pageInventoryLimitBytes = 1_048_576;

const isUnreadableInventoryError = (error: unknown): boolean =>
  unreadableInventoryCodes.some((code) => hasErrorCode(error, code));

const readPageInventory = async (directory: string): Promise<PageInventoryFile> => {
  const path = join(directory, inventoryFileName);
  let handle: FileHandle;

  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissingFile(error)) {
      return { path, read: { status: 'missing' } };
    }

    if (!isUnreadableInventoryError(error)) {
      throw error;
    }

    return { path, read: { status: 'unreadable' } };
  }

  try {
    const file = await handle.stat();

    if (!file.isFile()) {
      return { path, read: { status: 'notRegular' } };
    }

    if (file.size > pageInventoryLimitBytes) {
      return { path, read: { status: 'tooLarge' } };
    }

    const buffer = Buffer.alloc(pageInventoryLimitBytes + 1);
    let total = 0;

    while (total < buffer.length) {
      // oxlint-disable-next-line no-await-in-loop -- One bounded read depends on the bytes read before.
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);

      if (bytesRead === 0) {
        break;
      }

      total += bytesRead;
    }

    if (total > pageInventoryLimitBytes) {
      return { path, read: { status: 'tooLarge' } };
    }

    const text = buffer.subarray(0, total).toString('utf8');

    return { path, read: parsePageInventory(text) };
  } catch (error) {
    if (!isUnreadableInventoryError(error)) {
      throw error;
    }

    return { path, read: { status: 'unreadable' } };
  } finally {
    await handle.close();
  }
};

const pageInventoryRefusal = async (facts: ReportCheckFacts): Promise<string | undefined> => {
  const appUrl = hasAppUrlLine(facts.task);

  if (!appliesPageInventoryGate(facts.profile, appUrl)) {
    return undefined;
  }

  const { path, read } = await readPageInventory(facts.assignmentDirectory);

  const decision = decidePageInventoryGate({
    profile: facts.profile,
    appUrl,
    inventoryPath: path,
    read,
    summary: facts.summary,
    evidence: facts.evidence,
  });

  return decision.status === 'refuse' ? decision.message : undefined;
};

export const checkReport = async (facts: ReportCheckFacts): Promise<ReportGateDecision> => {
  const inventoryRefusal = await pageInventoryRefusal(facts);

  if (inventoryRefusal !== undefined) {
    return { status: 'refuse', message: inventoryRefusal };
  }

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
