import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { notifyOnce } from '../src/config/config.js';
import type { ConfigWarnings } from '../src/config/config.js';
import { releaseRegistration } from '../src/inbox/inbox.js';
import tauExtension from '../src/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

// Every feature may report config notices in its own session_start handler, so Tau must forget the
// previous session's notices before any of them runs.
it('forgets config notices in the first session_start handler after the session lock', async () => {
  const fake = fakeExtensionApi();

  // No session starts, so no session_shutdown releases the inbox that loading Tau claims.
  onTestFinished(releaseRegistration);
  await tauExtension(fake.pi);

  const notify = vi.fn<ConfigWarnings['notify']>();
  const ui: ConfigWarnings = { notify };
  const context = { ui } as unknown as ExtensionContext;
  // The session lock handler comes first, so a refused session runs no other handler.
  const [, first] = fake.handlers.get('session_start') ?? [];

  const report = () => {
    notifyOnce(ui, '/agent/tau.json', 'bogusKey', 'unknown key', 'warning');
  };

  report();
  report();
  await first?.({} as never, context);
  report();

  expect(notify).toHaveBeenCalledTimes(2);
});
