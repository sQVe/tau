import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { readConfigLocation, notifyOnce, userConfigPath } from '../../config/config.js';
import type { ConfigWarnings } from '../../config/config.js';
import { readRoleModel } from '../../config/roleModels.js';
import { errorMessage } from '../../errors.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { currentRole } from '../../role/role.js';
import { findTauRoot } from '../../tauDirectory.js';
import type { AnswerTracker, ClosedAnswers } from './answer.js';
import type { AskAdmissions } from './ask/askAcceptance.js';
import { nextEndNoteRoute } from './endNoteDecision.js';
import type { EndNoteRoute } from './endNoteDecision.js';
import { deliverEndNote, prepareEndNote } from './endNoteSend.js';
import { leadModelWarning } from './leadModelWarning.js';
import { holdArchitectLock } from './lock.js';
import { failOpenLiveAsks } from './open/openLiveAsks.js';
import type { FinalHandoverResult } from './queuedHandover.js';
import { readAskRecords, writeArchitectRecord, writeAskRecord } from './record.js';
import type { ArchitectOwner, HiddenAskRecord } from './record.js';

export interface HeldLockToken {
  current: () => string | undefined;
  set: (token: string | undefined) => void;
}

export interface ArchitectSession {
  root: string;
  release: () => Promise<void>;
  ui: ConfigWarnings;
  owner: ArchitectOwner;
  held: HeldLockToken;
  endNote?: EndNoteRoute;
}

export interface EndArchitectOptions {
  answers: AnswerTracker;
  admissions: AskAdmissions;
  sendEndNote: boolean;
}

export const createHeldLockToken = (): HeldLockToken => {
  let token: string | undefined;

  return {
    current: () => token,
    set: (next) => {
      token = next;
    },
  };
};

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

const architectMode = (): ArchitectOwner['mode'] => {
  // oxlint-disable-next-line node/no-process-env -- The ask terminal receives its record path in its environment.
  const askRecordPath = process.env.TAU_ARCHITECT_ASK;

  return askRecordPath !== undefined && askRecordPath !== '' ? 'ask' : 'visible';
};

const startArchitect = async (
  context: ExtensionContext,
  held: HeldLockToken,
  afterPublish?: () => Promise<void>,
): Promise<ArchitectSession | undefined> => {
  const root = await findTauRoot(context.cwd, 'architect');
  let release: (() => Promise<void>) | undefined;

  try {
    const lock = await holdArchitectLock(root);

    release = lock.release;
    held.set(lock.token);

    const owner: ArchitectOwner = {
      lockToken: lock.token,
      mode: architectMode(),
      terminal: currentTerminalAddress() ?? null,
      sessionId: context.sessionManager.getSessionId(),
    };

    // oxlint-disable-next-line node/no-process-env -- The lead passes its address in the pane environment.
    const leadTerminal = process.env.TAU_LEAD_TERMINAL ?? null;

    await writeArchitectRecord(root, {
      version: 2,
      sessionFile: context.sessionManager.getSessionFile() ?? null,
      leadTerminal,
      owner,
      updatedAt: new Date().toISOString(),
    });

    await afterPublish?.();

    const endNote =
      owner.mode === 'visible' && leadTerminal !== null && leadTerminal !== ''
        ? { leadTerminal, architectTerminal: owner.terminal, finalHandover: 'none' as const }
        : undefined;

    return {
      root,
      release: lock.release,
      ui: context.ui,
      owner,
      held,
      ...(endNote === undefined ? {} : { endNote }),
    };
  } catch (error) {
    held.set(undefined);
    await release?.();
    notifyOnce(context.ui, root, 'architect-start', errorMessage(error), 'error');
    context.shutdown();

    return undefined;
  }
};

export const startArchitectSession = async (
  context: ExtensionContext,
  held: HeldLockToken,
  afterPublish?: () => Promise<void>,
): Promise<ArchitectSession | undefined> => {
  const role = currentRole();

  if (role === 'lead') {
    warnLeadModel(context);

    return undefined;
  }

  return role === 'architect' ? startArchitect(context, held, afterPublish) : undefined;
};

const failRunningAsks = async (root: string, ui: ConfigWarnings): Promise<void> => {
  const { records, gaps } = await readAskRecords(root);

  for (const gap of gaps) {
    notifyOnce(ui, gap.path, 'ask-record', gap.reason, 'warning');
  }

  const running = records.filter(
    (record): record is HiddenAskRecord => record.route === 'hidden' && record.status === 'running',
  );

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

// Both waits start together, so they share one close limit.
const closeAdmitted = async (
  answers: AnswerTracker,
  admissions: AskAdmissions,
): Promise<ClosedAnswers> => {
  const [closed] = await Promise.all([answers.close(), admissions.settle()]);

  return closed;
};

const closeLiveAsks = async (
  session: ArchitectSession,
  hc: HcRuntime,
  closed: ClosedAnswers,
): Promise<void> => {
  if (session.owner.mode !== 'visible') {
    return;
  }

  const report = (message: string): void => {
    session.ui.notify(message, 'warning');
  };

  await failOpenLiveAsks(
    { root: session.root, sessionId: session.owner.sessionId },
    { hc, report, ...closed },
  ).catch((error: unknown) => {
    report(`The architect could not close its open asks: ${errorMessage(error)}`);
  });
};

export const recordFinalHandover = (
  session: ArchitectSession,
  result: FinalHandoverResult,
): void => {
  const route = nextEndNoteRoute(session.endNote, result);

  if (route === undefined) {
    delete session.endNote;
  } else {
    session.endNote = route;
  }
};

// The token goes first so no new question is saved. The wait lets a save that already started
// finish before the lock is released.
export const endArchitectSession = async (
  session: ArchitectSession,
  hc: HcRuntime,
  { answers, admissions, sendEndNote }: EndArchitectOptions,
): Promise<void> => {
  session.held.set(undefined);

  // The note read must finish before the lock is released, so a new owner cannot overwrite the
  // record first. The close work starts alongside it so its deadline starts now.
  const note = sendEndNote ? prepareEndNote(session.endNote, session.root) : undefined;
  const closing = closeAdmitted(answers, admissions);
  const preparedNote = await note;

  try {
    const closed = await closing;

    await closeLiveAsks(session, hc, closed);
    await session.release();
  } finally {
    try {
      await failRunningAsks(session.root, session.ui);
    } finally {
      await deliverEndNote(preparedNote, hc, (message) => {
        session.ui.notify(message, 'warning');
      });
    }
  }
};
