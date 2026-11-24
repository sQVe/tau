import type { HcFake } from '../../../../../tests/hcFake.js';
import { createHcFake } from '../../../../../tests/hcFake.js';
import { takingStartTicket } from '../../../../../tests/startTicketFake.js';
import { contextOf } from '../../fixtures/toolHarness.js';
import { readAskRecord, readAskRecords, writeAskRecord } from '../../record.js';
import type { HiddenAskRecord } from '../../record.js';
import { createArchitectTool } from '../../tool.js';

export const ask = (
  hc: HcFake,
  root: string,
): ReturnType<ReturnType<typeof createArchitectTool>['execute']> =>
  createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

export const statuses = async (root: string): Promise<string[]> => {
  const { records } = await readAskRecords(root);

  return records.map((record) => record.status);
};

export const details = async (root: string): Promise<(string | null)[]> => {
  const { records } = await readAskRecords(root);

  return records.map((record) => record.detail);
};

export const endedWait = (
  terminal: string,
  ended: boolean,
  exitCode: number | null = ended ? 0 : null,
  signal: number | null = null,
): string => {
  const reason = ended ? 'ended' : 'timeout';

  return JSON.stringify({
    terminal,
    ended,
    reason,
    turn: 1,
    children: [],
    exit_code: exitCode,
    signal,
  });
};

export const startFake = (): HcFake => {
  const hc = takingStartTicket(createHcFake());

  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));
  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'finished' }));

  return hc;
};

export const failFirstWait = (hc: HcFake, error: Error): HcFake => {
  let waits = 0;

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      if (waits === 1) {
        throw error;
      }
    }

    return hc.exec(command, commandArguments, options);
  };

  return { ...hc, exec };
};

export const endedWithRecord = (
  hc: HcFake,
  root: string,
  settle: (record: HiddenAskRecord) => HiddenAskRecord,
): HcFake['exec'] => {
  let askId: string | undefined;

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      const result = await hc.exec(command, commandArguments, options);
      const { records } = await readAskRecords(root);

      askId = records[0]?.askId;

      return result;
    }

    if (command === 'hc' && commandArguments[0] === 'wait' && askId !== undefined) {
      const record = await readAskRecord(root, askId);

      if (record?.route === 'hidden') {
        await writeAskRecord(root, settle(record));
      }
    }

    return hc.exec(command, commandArguments, options);
  };

  return exec;
};

export const runningAsk = {
  version: 3 as const,
  route: 'hidden' as const,
  askId: '0190c1d2-0000-7000-8000-000000000399',
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1900000000000,
  status: 'running' as const,
  detail: null,
  answer: null,
  gateRecord: null,
};
