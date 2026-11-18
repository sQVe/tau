import { randomUUID } from 'node:crypto';

import type { ConfigLocation, ConfigWarnings } from '../../../config/config.js';
import { notifyOnce, userConfigPath } from '../../../config/config.js';
import { readRoleModel } from '../../../config/roleModels.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { get, kill, run, wait } from '../../../hc/hc.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { piArguments } from '../../../piStart/piArguments.js';
import { askLiveArchitect } from '../liveAsk.js';
import type { LiveAskResult } from '../liveAsk.js';
import { architectLockPath } from '../lock.js';
import {
  askRecordPath,
  readArchitectRecord,
  readAskRecord,
  readAskRecords,
  writeAskRecord,
} from '../record.js';
import type { AskRecordGap, HiddenAskRecord } from '../record.js';
import { askOutcome, askRoute } from './askDecision.js';

export interface AskRequest {
  root: string;
  question: string;
  leadTerminal: string;
  leadSessionId: string;
  location: ConfigLocation;
  ui: ConfigWarnings;
  hc: HcRuntime;
}

export type AskResult =
  | LiveAskResult
  | { status: 'ended'; askId: string; answer: string }
  | { status: 'failed'; askId: string; reason: string };

export const askDeadlineSeconds = 900;

const millisecondsPerSecond = 1000;

const reportAskGaps = (ui: ConfigWarnings, gaps: AskRecordGap[]): void => {
  for (const gap of gaps) {
    notifyOnce(ui, gap.path, 'ask-record', gap.reason, 'warning');
  }
};

const liveRunningAsk = async (
  root: string,
  hc: HcRuntime,
  ui: ConfigWarnings,
): Promise<HiddenAskRecord | undefined> => {
  const { records, gaps } = await readAskRecords(root);

  reportAskGaps(ui, gaps);

  const newest = records.findLast((record): record is HiddenAskRecord => record.route === 'hidden');

  if (newest?.status !== 'running' || newest.terminal === null) {
    return undefined;
  }

  const terminal = await get(hc, newest.terminal).catch(() => undefined);

  return terminal?.state === 'live' ? newest : undefined;
};

const requireModel = (request: AskRequest): string => {
  const model = readRoleModel(request.location, 'architect', request.ui);

  if (model === undefined) {
    throw new Error(
      `Set roles.architect.model in ${userConfigPath(request.location.agentDirectory)}.`,
    );
  }

  return model;
};

const needsOpen = (reason: string): AskResult => ({ status: 'needsOpen', reason });

const askHiddenArchitect = async (request: AskRequest, sessionFile: string): Promise<AskResult> => {
  const model = requireModel(request);
  const askId = randomUUID();
  const recordPath = askRecordPath(request.root, askId);

  const initial: HiddenAskRecord = {
    version: 2,
    route: 'hidden',
    askId,
    createdAt: new Date().toISOString(),
    question: request.question,
    sessionFile,
    terminal: null,
    leadTerminal: request.leadTerminal,
    deadline: Date.now() + askDeadlineSeconds * millisecondsPerSecond,
    status: 'running',
    detail: null,
    answer: null,
  };

  await writeAskRecord(request.root, initial);

  const terminal = await run(request.hc, {
    argv: piArguments({
      model,
      session: sessionFile,
      environment: {
        TAU_ROLE: 'architect',
        TAU_ARCHITECT_ASK: recordPath,
        TAU_LEAD_TERMINAL: request.leadTerminal,
      },
      message: request.question,
    }),
    cwd: request.root,
    background: true,
    noParent: true,
    notify: false,
    labels: { 'tau.architect.ask': askId },
  });

  const started: HiddenAskRecord = { ...initial, terminal: terminal.address };

  await writeAskRecord(request.root, started);

  const waited = await wait(request.hc, terminal.address, { timeout: askDeadlineSeconds });

  if (!waited.ended) {
    await kill(request.hc, terminal.address);

    await writeAskRecord(request.root, {
      ...started,
      status: 'timeout',
      detail: 'The ask reached its deadline before the architect answered.',
    });

    return needsOpen('The ask reached its deadline. Call architect open to talk to the architect.');
  }

  const recorded = await readAskRecord(request.root, askId);
  const latest: HiddenAskRecord = recorded?.route === 'hidden' ? recorded : started;

  const outcome = askOutcome({
    status: latest.status,
    ended: waited.ended,
    exitCode: waited.exit_code ?? null,
  });

  if (outcome === 'answered' && latest.answer !== null) {
    return { status: 'ended', askId, answer: latest.answer };
  }

  if (outcome === 'needsOpen') {
    await writeAskRecord(request.root, {
      ...latest,
      status: 'failed',
      detail: 'The ask ended without sending an answer.',
    });

    return needsOpen(
      'The architect ended without sending an answer. Call architect open to talk to it.',
    );
  }

  await writeAskRecord(request.root, {
    ...latest,
    status: 'failed',
    detail: 'The ask terminal failed before the architect answered.',
  });

  return {
    status: 'failed',
    askId,
    reason: 'The ask terminal failed before the architect answered. Call architect open instead.',
  };
};

export const askArchitect = async (request: AskRequest): Promise<AskResult> => {
  const architect = await readArchitectRecord(request.root);
  const holder = await readLiveLockHolder(architectLockPath(request.root));

  const holderFacts =
    holder === undefined ? undefined : { checkout: holder.checkout, token: holder.token };

  const route = askRoute({
    root: request.root,
    holder: holderFacts,
    owner: architect?.owner ?? null,
    sessionFile: architect?.sessionFile ?? null,
  });

  if (route.kind === 'needsOpen') {
    return needsOpen(route.reason);
  }

  const running = await liveRunningAsk(request.root, request.hc, request.ui);

  if (running !== undefined) {
    return needsOpen(`Ask ${running.askId} is still running. Wait for it to answer.`);
  }

  if (route.kind === 'live') {
    return askLiveArchitect(request, route);
  }

  return askHiddenArchitect(request, route.sessionFile);
};
