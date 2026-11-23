import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { createAnswerTracker } from './answer.js';
import { createAskAdmissions } from './ask/askAcceptance.js';
import { startLeadInbox } from './fixtures/leadInbox.js';
import { hcRuntime, visibleArchitect } from './fixtures/visibleSession.js';
import { architectLockPath } from './lock.js';
import { writeArchitectRecord } from './record.js';
import { endArchitectSession, recordEndNoteStatus } from './session.js';

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

  await endArchitectSession(
    session,
    hcRuntime(hc),
    createAnswerTracker(),
    createAskAdmissions(() => undefined),
  );

  const names = lead.savedRecords().filter((name) => name.endsWith('.json'));

  expect(names).toHaveLength(1);

  const text = await readFile(join(lead.inbox, basename(names[0] as string)), 'utf8');
  const saved = JSON.parse(text) as { payload: { text: string } };

  expect(saved.payload.text).toContain('t-architect');
  expect(saved.payload.text).toContain('/sessions/departing.jsonl');
  expect(saved.payload.text).toContain(departing.updatedAt);
  expect(saved.payload.text).not.toContain('/sessions/successor.jsonl');
  expect(lockAtAccept).toBeUndefined();
});

it('ending a visible architect after a queued final handover sends the lead nothing', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const hc = createHcFake();
  const lead = await startLeadInbox(onTestFinished, hc);
  const { session } = await visibleArchitect(onTestFinished);

  recordEndNoteStatus(session, 'queued');

  await endArchitectSession(
    session,
    hcRuntime(hc),
    createAnswerTracker(),
    createAskAdmissions(() => undefined),
  );

  const saved = lead.savedRecords().filter((name) => name.endsWith('.json'));

  expect(saved).toEqual([]);
});

it('ending a visible architect releases the lock and warns once when the end note fails', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_LEAD_TERMINAL', 't-lead');

  const { root, session } = await visibleArchitect(onTestFinished);
  const hc = createHcFake();
  const notify = session.ui.notify as unknown as Mock;

  hc.fail('get', 'no such terminal', 1);

  await endArchitectSession(
    session,
    hcRuntime(hc),
    createAnswerTracker(),
    createAskAdmissions(() => undefined),
  );

  const warnings = notify.mock.calls.filter(([message]) => String(message).includes('end note'));

  expect(warnings).toHaveLength(1);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
