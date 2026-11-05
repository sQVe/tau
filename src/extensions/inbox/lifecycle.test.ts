import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import type { InboxWatch } from '../../inbox/inbox.js';
import inboxExtension from './inbox.js';
import { registerInboxLifecycle } from './lifecycle.js';

const contextOf = (): ExtensionContext =>
  ({
    sessionManager: { getSessionId: () => 'session-1', getEntries: () => [] },
    ui: { notify: () => undefined },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as ExtensionContext;

const createWatch = () => {
  const start = vi.fn<InboxWatch['start']>();
  const stop = vi.fn<InboxWatch['stop']>();
  const requestScan = vi.fn<InboxWatch['requestScan']>();

  return { watch: { start, stop, requestScan } as InboxWatch, start, stop, requestScan };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

it('starts the watch at session start when a terminal address exists', () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');

  const fake = fakeExtensionApi();
  const { watch, start } = createWatch();

  registerInboxLifecycle(fake.pi, watch);
  fake.handler('session_start')({}, contextOf());

  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]?.[0].sessionId).toBe('session-1');
});

it('starts no watch without a terminal address', () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const fake = fakeExtensionApi();
  const { watch, start } = createWatch();

  registerInboxLifecycle(fake.pi, watch);
  fake.handler('session_start')({}, contextOf());

  expect(start).not.toHaveBeenCalled();
});

it('requests a scan at turn end and settlement and stops at shutdown', () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');

  const fake = fakeExtensionApi();
  const { watch, stop, requestScan } = createWatch();

  registerInboxLifecycle(fake.pi, watch);
  fake.handler('turn_end')({}, contextOf());
  fake.handler('agent_settled')({}, contextOf());
  fake.handler('session_shutdown')({ reason: 'quit' }, contextOf());

  expect(requestScan).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledTimes(1);
});

it('returns the watch teardown promise at shutdown', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');

  const fake = fakeExtensionApi();
  const { watch, stop } = createWatch();
  const teardown = Promise.withResolvers<undefined>();

  stop.mockReturnValue(teardown.promise);
  registerInboxLifecycle(fake.pi, watch);

  const result = fake.handler('session_shutdown')({ reason: 'quit' }, contextOf());

  expect(result).toBe(teardown.promise);

  teardown.resolve(undefined);
  await result;
});

it.each(['', 'worker'] as const)('registers the inbox with TAU_ROLE=%s', (role) => {
  vi.stubEnv('TAU_ROLE', role);

  const fake = fakeExtensionApi();

  inboxExtension(fake.pi);

  expect(fake.handlers.has('turn_end')).toBe(true);
  expect(fake.handlers.has('agent_settled')).toBe(true);
  expect(fake.handlers.has('session_shutdown')).toBe(true);
});
