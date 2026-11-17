import { randomUUID } from 'node:crypto';

import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { userConfigPath } from '../../config/config.js';
import { readRoleModel } from '../../config/roleModels.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { get, kill, run, wait } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { piArguments } from '../../piStart/piArguments.js';
import { askOutcome } from './askDecision.js';
import { architectLockPath } from './lock.js';
import {
  askRecordPath,
  readArchitectRecord,
  readAskRecord,
  readAskRecords,
  writeAskRecord,
} from './record.js';
import type { AskRecord } from './record.js';

export interface AskRequest {
  root: string;
  question: string;
  leadTerminal: string;
  location: ConfigLocation;
  ui: ConfigWarnings;
  hc: HcRuntime;
}

export type AskResult =
  | { status: 'needsOpen'; reason: string }
  | { status: 'ended'; askId: string }
  | { status: 'failed'; askId: string; reason: string };

export const askDeadlineSeconds = 900;

const millisecondsPerSecond = 1000;

const liveRunningAsk = async (root: string, hc: HcRuntime): Promise<AskRecord | undefined> => {
  const records = await readAskRecords(root);
  const newest = records.at(-1);

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

export const askArchitect = async (request: AskRequest): Promise<AskResult> => {
  const architect = await readArchitectRecord(request.root);
  const sessionFile = architect?.sessionFile ?? undefined;

  if (sessionFile === undefined) {
    return needsOpen(
      'No architect session is recorded for this checkout. Call architect open first.',
    );
  }

  const holder = await readLiveLockHolder(architectLockPath(request.root));

  if (holder !== undefined) {
    return needsOpen(
      `The architect is already running in ${holder.checkout}. Call architect open to talk to it.`,
    );
  }

  const running = await liveRunningAsk(request.root, request.hc);

  if (running !== undefined) {
    return needsOpen(`Ask ${running.askId} is still running. Wait for it, or call architect open.`);
  }

  const model = requireModel(request);
  const askId = randomUUID();
  const recordPath = askRecordPath(request.root, askId);

  const initial: AskRecord = {
    version: 1,
    askId,
    createdAt: new Date().toISOString(),
    question: request.question,
    sessionFile,
    terminal: null,
    leadTerminal: request.leadTerminal,
    deadline: Date.now() + askDeadlineSeconds * millisecondsPerSecond,
    status: 'running',
    detail: null,
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

  const started: AskRecord = { ...initial, terminal: terminal.address };

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

  const latest = (await readAskRecord(request.root, askId)) ?? started;

  const outcome = askOutcome({
    status: latest.status,
    ended: waited.ended,
    exitCode: waited.exit_code ?? null,
  });

  if (outcome === 'answered') {
    return { status: 'ended', askId };
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
