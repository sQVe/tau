import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import inboxExtension from './inbox.js';

const registeredEvents = (fake: ReturnType<typeof fakeExtensionApi>): string[] =>
  [...fake.handlers.keys()].toSorted();

const shutdown = async (fake: ReturnType<typeof fakeExtensionApi>): Promise<void> => {
  const context = { ui: { notify: () => undefined } } as unknown as ExtensionContext;

  for (const handler of fake.handlers.get('session_shutdown') ?? []) {
    await handler({ type: 'session_shutdown', reason: 'reload' } as never, context);
  }
};

it('registers one listener and one guard when a process loads the inbox twice', async () => {
  const first = fakeExtensionApi();
  const second = fakeExtensionApi();

  inboxExtension(first.pi);
  inboxExtension(second.pi);

  expect(first.handlers.get('tool_call')).toHaveLength(1);
  expect(registeredEvents(first)).toContain('session_start');
  expect(registeredEvents(second)).toEqual([]);

  await shutdown(first);
});

it('registers again after the session shut down, as a reload does', async () => {
  const first = fakeExtensionApi();
  const reloaded = fakeExtensionApi();

  inboxExtension(first.pi);
  await shutdown(first);
  inboxExtension(reloaded.pi);

  expect(registeredEvents(reloaded)).toEqual(registeredEvents(first));

  await shutdown(reloaded);
});
