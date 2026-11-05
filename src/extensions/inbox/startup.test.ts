import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createStartupGate } from './startup.js';

const context = {} as ExtensionContext;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('opens on the next macrotask after resources_discover', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);

  fake.handler('session_start')({ reason: 'startup' }, context);

  expect(gate.isReady()).toBe(false);

  fake.handler('resources_discover')({ type: 'resources_discover' }, context);

  expect(gate.isReady()).toBe(false);

  await vi.advanceTimersByTimeAsync(0);

  expect(gate.isReady()).toBe(true);
});

it('does not open before session_start', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);

  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  await vi.advanceTimersByTimeAsync(0);

  expect(gate.isReady()).toBe(false);
});

it('resolves whenReady once the gate opens', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);
  let ready = false;

  const waiting = (async (): Promise<void> => {
    await gate.whenReady();
    ready = true;
  })();

  fake.handler('session_start')({ reason: 'startup' }, context);
  expect(ready).toBe(false);

  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  await vi.advanceTimersByTimeAsync(0);
  await waiting;

  expect(ready).toBe(true);
});

it('cancels a scheduled open at session_shutdown', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);

  fake.handler('session_start')({ reason: 'startup' }, context);
  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  fake.handler('session_shutdown')({ reason: 'quit' }, context);

  await vi.advanceTimersByTimeAsync(0);

  expect(gate.isReady()).toBe(false);
});

it('cancels a scheduled open when session_start reloads', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);

  fake.handler('session_start')({ reason: 'startup' }, context);
  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  fake.handler('session_start')({ reason: 'reload' }, context);

  await vi.advanceTimersByTimeAsync(0);

  expect(gate.isReady()).toBe(false);
});

it('closes again on session_start and stays closed after session_shutdown', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);

  fake.handler('session_start')({ reason: 'startup' }, context);
  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  await vi.advanceTimersByTimeAsync(0);
  expect(gate.isReady()).toBe(true);

  fake.handler('session_start')({ reason: 'reload' }, context);
  expect(gate.isReady()).toBe(false);

  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  await vi.advanceTimersByTimeAsync(0);
  expect(gate.isReady()).toBe(true);

  fake.handler('session_shutdown')({ reason: 'quit' }, context);
  expect(gate.isReady()).toBe(false);

  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  await vi.advanceTimersByTimeAsync(0);
  expect(gate.isReady()).toBe(false);
});
