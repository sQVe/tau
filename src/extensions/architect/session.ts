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
import type { AskDeadline } from './ask/askDeadline.js';
import { startAskDeadline } from './ask/askDeadline.js';
import { initialEndNoteRoute, nextEndNoteRoute } from './endNoteDecision.js';
import type { EndNoteRoute } from './endNoteDecision.js';
import { deliverEndNote, prepareEndNote } from './endNoteSend.js';
import { startClaim } from './handoffDecision.js';
import type { StartClaim } from './handoffDecision.js';
import { leadModelWarning } from './leadModelWarning.js';
import { holdArchitectLock } from './lock.js';
import type { ArchitectLock } from './lock.js';
import { failOpenLiveAsks } from './open/openLiveAsks.js';
import type { FinalHandoverResult } from './queuedHandover.js';
import { readAskRecords, updateHiddenAskRecord, writeArchitectRecord } from './record.js';
import type { ArchitectOwner, HiddenAskRecord } from './record.js';
import { keepsLock } from './shutdownDecision.js';
import type { ShutdownReason } from './shutdownDecision.js';
import { adoptStartMarker } from './startTicket/startTicket.js';

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
  deadline?: AskDeadline;
}

export interface EndArchitectOptions {
  answers: AnswerTracker;
  admissions: AskAdmissions;
  reason: ShutdownReason;
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

const environmentValue = (value: string | undefined): string | undefined =>
  value === '' ? undefined : value;

const handoffFacts = (): { claimToken: string | undefined; handoffRoot: string | undefined } => {
  // oxlint-disable-next-line node/no-process-env -- The previous runtime passes the lock it kept.
  const claimToken = process.env.TAU_ARCHITECT_CLAIM;
  // oxlint-disable-next-line node/no-process-env -- The previous runtime passes the checkout it left.
  const handoffRoot = process.env.TAU_ARCHITECT_HANDOFF_ROOT;

  return { claimToken: environmentValue(claimToken), handoffRoot: environmentValue(handoffRoot) };
};

const askRecordPathFromEnvironment = (): string | undefined => {
  // oxlint-disable-next-line node/no-process-env -- The ask terminal receives its record path in its environment.
  return environmentValue(process.env.TAU_ARCHITECT_ASK);
};

// The old checkout goes first, so a refused new start never leaves it locked. If the old lock cannot
// be taken back, it still frees when the kernel reads this process as gone.
const releasePreviousLock = async (
  previousRoot: string,
  token: string,
  ui: ConfigWarnings,
): Promise<void> => {
  try {
    const previous = await holdArchitectLock(previousRoot, token);

    await previous.release();
  } catch (error) {
    ui.notify(
      `The architect could not release its lock in ${previousRoot}: ${errorMessage(error)}`,
      'warning',
    );
  }
};

const takeStartLock = async (
  root: string,
  claim: StartClaim,
  ui: ConfigWarnings,
): Promise<ArchitectLock> => {
  if (claim.kind === 'leave') {
    await releasePreviousLock(claim.previousRoot, claim.token, ui);
  }

  const token = claim.kind === 'adopt' ? claim.token : undefined;
  const lock = await holdArchitectLock(root, token);

  if (token !== undefined) {
    await adoptStartMarker(root, token, process.pid).catch(() => undefined);
  }

  return lock;
};

const startArchitect = async (
  context: ExtensionContext,
  held: HeldLockToken,
  afterPublish?: () => Promise<void>,
): Promise<ArchitectSession | undefined> => {
  const root = await findTauRoot(context.cwd, 'architect');
  let release: (() => Promise<void>) | undefined;

  try {
    const facts = handoffFacts();

    // oxlint-disable-next-line node/no-process-env -- The handoff names one next start only.
    delete process.env['TAU_ARCHITECT_CLAIM'];
    // oxlint-disable-next-line node/no-process-env -- The handoff names one next start only.
    delete process.env['TAU_ARCHITECT_HANDOFF_ROOT'];

    const claim = startClaim({ ...facts, root });
    const lock = await takeStartLock(root, claim, context.ui);

    release = lock.release;
    held.set(lock.token);

    const askPath = askRecordPathFromEnvironment();

    const owner: ArchitectOwner = {
      lockToken: lock.token,
      mode: askPath === undefined ? 'visible' : 'ask',
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

    const endNote = initialEndNoteRoute({
      mode: owner.mode,
      leadTerminal,
      architectTerminal: owner.terminal,
    });

    const deadline =
      askPath === undefined ? undefined : await startAskDeadline(root, askPath, context);

    return {
      root,
      release: lock.release,
      ui: context.ui,
      owner,
      held,
      ...(endNote === undefined ? {} : { endNote }),
      ...(deadline === undefined ? {} : { deadline }),
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

  const hidden = records.filter(
    (record): record is HiddenAskRecord => record.route === 'hidden' && record.status === 'running',
  );

  await Promise.all(
    hidden.map((record) =>
      updateHiddenAskRecord(root, record.askId, (current) => ({
        ...current,
        status: 'failed',
        detail: 'The architect session ended before it sent the answer.',
      })),
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

// A same-process runtime replacement keeps the lock, so no caller can take it between the two
// runtimes. The next session start adopts the token from the environment after it compares the
// checkout root. Only quit releases the lock, because the process is about to end.
const handOffLock = async (session: ArchitectSession, reason: ShutdownReason): Promise<void> => {
  if (keepsLock(reason)) {
    // oxlint-disable-next-line node/no-process-env -- The next runtime reads the token it must adopt.
    process.env['TAU_ARCHITECT_CLAIM'] = session.owner.lockToken;
    // oxlint-disable-next-line node/no-process-env -- The next runtime compares its checkout with this root.
    process.env['TAU_ARCHITECT_HANDOFF_ROOT'] = session.root;

    return;
  }

  await session.release();
};

// The token goes first so no new question is saved. The wait lets a save that already started
// finish before the lock is released.
export const endArchitectSession = async (
  session: ArchitectSession,
  hc: HcRuntime,
  { answers, admissions, reason, sendEndNote }: EndArchitectOptions,
): Promise<void> => {
  session.held.set(undefined);

  await session.deadline?.stop().catch((error: unknown) => {
    session.ui.notify(`The ask deadline could not be stopped: ${errorMessage(error)}`, 'warning');
  });

  // The note read must finish before the lock is released, so a new owner cannot overwrite the
  // record first. It starts with the close so its deadline starts now, but live ask settlement does
  // not wait for it.
  const note =
    sendEndNote && session.endNote !== undefined
      ? prepareEndNote(session.endNote, session.root)
      : undefined;

  const closing = closeAdmitted(answers, admissions);

  try {
    try {
      const closed = await closing;

      await closeLiveAsks(session, hc, closed);
      await note;
    } finally {
      await failRunningAsks(session.root, session.ui);
    }
  } finally {
    try {
      await handOffLock(session, reason);
    } finally {
      if (note !== undefined) {
        await deliverEndNote(await note, hc, (message) => {
          session.ui.notify(message, 'warning');
        });
      }
    }
  }
};
