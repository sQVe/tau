import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { readConfigLocation, notifyOnce, userConfigPath } from '../../config/config.js';
import { readRoleModel } from '../../config/roleModels.js';
import { errorMessage } from '../../errors.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import { currentRole } from '../../role/role.js';
import { findTauRoot } from '../../tauDirectory.js';
import { leadModelWarning } from './leadModelWarning.js';
import { holdArchitectLock } from './lock.js';
import { readAskRecords, writeArchitectRecord, writeAskRecord } from './record.js';

export interface ArchitectSession {
  root: string;
  release: () => Promise<void>;
}

const modelReference = (context: ExtensionContext): string | undefined =>
  context.model === undefined ? undefined : `${context.model.provider}/${context.model.id}`;

const warnLeadModel = (context: ExtensionContext): void => {
  const location = readConfigLocation(context.cwd, {}, context);
  const source = userConfigPath(location.agentDirectory);

  try {
    const warning = leadModelWarning({
      role: 'lead',
      model: modelReference(context),
      configured: readRoleModel(location, 'lead', context.ui),
    });

    if (warning !== undefined) {
      notifyOnce(context.ui, source, 'lead-model', warning, 'warning');
    }
  } catch (error) {
    notifyOnce(context.ui, source, 'lead-model-config', errorMessage(error), 'error');
  }
};

const startArchitect = async (context: ExtensionContext): Promise<ArchitectSession | undefined> => {
  const root = await findTauRoot(context.cwd, 'architect');

  try {
    const release = await holdArchitectLock(root);

    try {
      await writeArchitectRecord(root, {
        version: 1,
        sessionFile: context.sessionManager.getSessionFile() ?? null,
        terminal: currentTerminalAddress() ?? null,
        // oxlint-disable-next-line node/no-process-env -- The lead passes its address in the pane environment.
        leadTerminal: process.env.TAU_LEAD_TERMINAL ?? null,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      await release();

      throw error;
    }

    return { root, release };
  } catch (error) {
    notifyOnce(context.ui, root, 'architect-start', errorMessage(error), 'error');
    context.shutdown();

    return undefined;
  }
};

export const startArchitectSession = async (
  context: ExtensionContext,
): Promise<ArchitectSession | undefined> => {
  const role = currentRole();

  if (role === 'lead') {
    warnLeadModel(context);

    return undefined;
  }

  return role === 'architect' ? startArchitect(context) : undefined;
};

const failRunningAsks = async (root: string): Promise<void> => {
  const records = await readAskRecords(root);
  const running = records.filter((record) => record.status === 'running');

  await Promise.all(
    running.map((record) =>
      writeAskRecord(root, {
        ...record,
        status: 'failed',
        detail: 'The architect session ended before it sent the answer.',
      }),
    ),
  );
};

export const endArchitectSession = async (session: ArchitectSession): Promise<void> => {
  try {
    await session.release();
  } finally {
    await failRunningAsks(session.root);
  }
};
