import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { openEndpoint, socketPathFor } from '../../inbox/endpoint.js';
import { formatInboxLabel } from '../../inbox/protocol.js';
import { createAnswerTracker } from './answer.js';
import { createAskAdmissions } from './ask/askAcceptance.js';
import { startLeadInbox } from './fixtures/leadInbox.js';
import { hcRuntime, visibleArchitect } from './fixtures/visibleSession.js';
import { architectLockPath } from './lock.js';
import { architectRecordPath, writeArchitectRecord } from './record.js';
import { endArchitectSession, recordFinalHandover } from './session.js';

const endOptions = () => ({
  answers: createAnswerTracker(),
  admissions: createAskAdmissions(() => undefined),
  sendEndNote: true,
});

const savedNoteText = async (lead: HandoverReceiver): Promise<string> => {
  const name = lead.savedRecords().find((entry) => entry.endsWith('.json'));

  if (name === undefined) {
    throw new Error('The lead saved no note.');
  }

  const text = await readFile(join(lead.inbox, basename(name)), 'utf8');

  return (JSON.parse(text) as { payload: { text: string } }).payload.text;
};

const endNoteWarnings = (notify: Mock): string[] =>
  notify.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes('end note'));

const lostLeadInbox = async (
  onTestFinished: (cleanup: () => Promise<void> | void) => void,
): Promise<string> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-architect-lost-note-');

  const endpoint = await openEndpoint({
    path: socketPathFor(directory, 'session-lost'),
    respond: () => Promise.reject(new Error('The reply was lost.')),
  });

  onTestFinished(() => endpoint.close());

  return endpoint.path;
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

it('ending a visible architect after a queued final handover to another terminal still notes it', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const hc = createHcFake();
  const lead = await startLeadInbox(onTestFinished, hc);
  const { session } = await visibleArchitect(onTestFinished);

  recordFinalHandover(session, { status: 'queued', terminal: 't-other' });

  await endArchitectSession(session, hcRuntime(hc), endOptions());

  expect(await savedNoteText(lead)).toContain('ended without a final handover');
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
  const inbox = await lostLeadInbox(onTestFinished);

  hc.replyGet(
    't-lead',
    JSON.stringify({
      address: 't-lead',
      name: null,
      state: 'live',
      labels: { 'tau.inbox': formatInboxLabel(inbox) },
    }),
  );

  const { session } = await visibleArchitect(onTestFinished);
  const notify = session.ui.notify as unknown as Mock;

  await endArchitectSession(session, hcRuntime(hc), endOptions());

  const warnings = endNoteWarnings(notify);

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
