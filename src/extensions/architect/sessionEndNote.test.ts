import { rm, writeFile } from 'node:fs/promises';

import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import { savedTexts } from '../../../tests/inboxReceiverHarness.js';
import type { HandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { formatInboxLabel } from '../../inbox/protocol.js';
import { startCapturingInbox } from './fixtures/capturingInbox.js';
import { startLeadInbox } from './fixtures/leadInbox.js';
import { endOptions, hcRuntime, visibleArchitect } from './fixtures/visibleSession.js';
import { architectLockPath } from './lock.js';
import {
  architectRecordPath,
  readAskRecord,
  writeArchitectRecord,
  writeAskRecord,
} from './record.js';
import type { LiveAskRecord } from './record.js';
import { endArchitectSession, recordFinalHandover } from './session.js';

const noteRead = vi.hoisted(() => {
  const started = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();

  return { hold: false, started, resume };
});

vi.mock(import('./endNoteSend.js'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    prepareEndNote: async (...argumentsList: Parameters<typeof actual.prepareEndNote>) => {
      if (noteRead.hold) {
        noteRead.started.resolve(undefined);
        await noteRead.resume.promise;
      }

      return actual.prepareEndNote(...argumentsList);
    },
  };
});

const savedNoteText = async (lead: HandoverReceiver): Promise<string> => {
  const [text] = await savedTexts(lead);

  if (text === undefined) {
    throw new Error('The lead saved no note.');
  }

  return text;
};

const endNoteWarnings = (notify: Mock): string[] =>
  notify.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes('end note'));

const openAsk: LiveAskRecord = {
  version: 2,
  route: 'live',
  askId: '0190c1d2-0000-7000-8000-000000000401',
  createdAt: '2026-11-23T08:00:00.000Z',
  question: 'Which flag name?',
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  architectTerminal: 't-architect',
  architectSessionId: 'session-architect',
  architectLockToken: 'live',
  status: 'queued',
  detail: null,
  answer: null,
};

it('ending a visible architect tells the lead the departing record after release', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const { root, session } = await visibleArchitect(onTestFinished);

  const departing = {
    version: 2 as const,
    sessionFile: '/sessions/departing.jsonl',
    leadTerminal: 't-lead',
    owner: session.owner,
    updatedAt: '2026-11-23T08:30:00.000Z',
  };

  await writeArchitectRecord(root, departing);

  const hc = createHcFake();
  let lockAtAccept: Awaited<ReturnType<typeof readLiveLockHolder>> = undefined;

  const lead = await startLeadInbox(onTestFinished, hc, 'session-lead', {
    beforeCommit: async () => {
      lockAtAccept = await readLiveLockHolder(architectLockPath(root));
    },
  });

  const release = session.release;

  session.release = async () => {
    await writeArchitectRecord(root, {
      ...departing,
      sessionFile: '/sessions/successor.jsonl',
      updatedAt: '2026-11-23T09:30:00.000Z',
    });

    await release();
  };

  await endArchitectSession(session, hcRuntime(hc), endOptions());

  const names = lead.savedRecords().filter((name) => name.endsWith('.json'));

  expect(names).toHaveLength(1);

  const text = await savedNoteText(lead);

  expect(text).toContain('t-architect');
  expect(text).toContain('/sessions/departing.jsonl');
  expect(text).toContain(departing.updatedAt);
  expect(text).not.toContain('/sessions/successor.jsonl');
  expect(lockAtAccept).toBeUndefined();
  expect(endNoteWarnings(session.ui.notify as unknown as Mock)).toEqual([]);
});

it('ending a visible architect after a queued final handover to its lead sends nothing', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const hc = createHcFake();
  const lead = await startLeadInbox(onTestFinished, hc);
  const { session } = await visibleArchitect(onTestFinished);

  recordFinalHandover(session, { status: 'queued', terminal: 't-lead' });

  await endArchitectSession(session, hcRuntime(hc), endOptions());

  const saved = lead.savedRecords().filter((name) => name.endsWith('.json'));

  expect(saved).toEqual([]);
});

it('ending a visible architect with a missing record tells the lead the record is missing', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const hc = createHcFake();
  const lead = await startLeadInbox(onTestFinished, hc);
  const { root, session } = await visibleArchitect(onTestFinished);

  await rm(architectRecordPath(root), { force: true });

  await endArchitectSession(session, hcRuntime(hc), endOptions());

  expect(await savedNoteText(lead)).toContain('Its record is missing.');
});

it('ending a visible architect with a malformed record tells the lead the record is unreadable', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const hc = createHcFake();
  const lead = await startLeadInbox(onTestFinished, hc);
  const { root, session } = await visibleArchitect(onTestFinished);

  await writeFile(architectRecordPath(root), '{"version":2');

  await endArchitectSession(session, hcRuntime(hc), endOptions());

  expect(await savedNoteText(lead)).toContain('Its record could not be read:');
});

it('ending a visible architect warns that delivery is unknown when the lead does not confirm', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const hc = createHcFake();

  const inbox = await startCapturingInbox(
    onTestFinished,
    'session-lead',
    'suppress',
    undefined,
    't-lead',
  );

  hc.replyGet(
    't-lead',
    JSON.stringify({
      address: 't-lead',
      name: null,
      state: 'live',
      labels: { 'tau.inbox': formatInboxLabel(inbox.path) },
    }),
  );

  const { session } = await visibleArchitect(onTestFinished);
  const notify = session.ui.notify as unknown as Mock;

  await endArchitectSession(session, hcRuntime(hc), endOptions());

  const warnings = endNoteWarnings(notify);

  expect(inbox.saved()).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('unknown');
  expect(warnings[0]).not.toContain('got no end note');
});

it('ending a visible architect releases the lock and warns once when the end note fails', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const { root, session } = await visibleArchitect(onTestFinished);
  const hc = createHcFake();
  const notify = session.ui.notify as unknown as Mock;

  hc.fail('get', 'no such terminal', 1);

  await endArchitectSession(session, hcRuntime(hc), endOptions());

  const warnings = endNoteWarnings(notify);

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('got no end note');
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('ending settles live asks without waiting for the note record read', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');
  noteRead.hold = true;

  onTestFinished(() => {
    noteRead.hold = false;
    noteRead.resume.resolve(undefined);
  });

  const hc = createHcFake();
  const lead = await startLeadInbox(onTestFinished, hc);
  const { root, session } = await visibleArchitect(onTestFinished);

  await writeAskRecord(root, openAsk);

  const ending = endArchitectSession(session, hcRuntime(hc), endOptions());

  await noteRead.started.promise;

  await vi.waitFor(async () => {
    expect(await readAskRecord(root, openAsk.askId)).toMatchObject({ status: 'failed' });
  });

  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();

  noteRead.resume.resolve(undefined);
  await ending;

  const savedRecords = lead.savedRecords().filter((name) => name.endsWith('.json'));

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(savedRecords).toHaveLength(2);
});

it('ending still sends the end note when the admitted close fails', async ({ onTestFinished }) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const hc = createHcFake();
  const lead = await startLeadInbox(onTestFinished, hc);
  const { session } = await visibleArchitect(onTestFinished);
  const options = endOptions();
  const failure = new Error('The admitted close failed.');

  const ending = endArchitectSession(session, hcRuntime(hc), {
    ...options,
    admissions: { ...options.admissions, settle: () => Promise.reject(failure) },
  });

  await expect(ending).rejects.toThrow(failure);
  expect(await savedNoteText(lead)).toContain('ended without a final handover');
});
