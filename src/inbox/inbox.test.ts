import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { currentInboxPath, startInbox } from './inbox.js';
import { refusedReply } from './protocol.js';

it('a stopped inbox reports no current path', async ({ onTestFinished: cleanup }) => {
  const directory = temporaryDirectory(cleanup, 'tau-current-inbox-');

  const listener = await startInbox({
    sessionId: 'session-current',
    terminal: 't-current',
    directory,
    accept: () => Promise.resolve(refusedReply('Not used.')),
    onQueued: () => undefined,
    advertise: () => Promise.resolve(),
    withdraw: () => Promise.resolve(),
  });

  cleanup(() => listener.stop());

  expect(currentInboxPath()).toBe(`${directory}/session-current.sock`);

  await listener.stop();

  expect(currentInboxPath()).toBeUndefined();
});
