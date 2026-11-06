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

  fake.handler('session_start')({ reason: 'startup' }, context);

  const waiting = (async (): Promise<void> => {
    await gate.whenReady(new AbortController().signal);
    ready = true;
  })();

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

it('rejects a waiter from an ended generation and never resolves it into the next one', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);
  const outcomes: string[] = [];

  fake.handler('session_start')({ reason: 'startup' }, context);

  const earlier = gate.whenReady(new AbortController().signal).then(
    () => outcomes.push('resolved'),
    () => outcomes.push('rejected'),
  );

  fake.handler('session_start')({ reason: 'reload' }, context);
  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  await vi.advanceTimersByTimeAsync(0);
  await earlier;

  expect(gate.isReady()).toBe(true);
  expect(outcomes).toEqual(['rejected']);
});

it('rejects a waiter whose signal aborts and still opens for later waiters', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);
  const generation = new AbortController();
  const outcomes: string[] = [];

  fake.handler('session_start')({ reason: 'startup' }, context);

  const aborted = gate.whenReady(generation.signal).then(
    () => outcomes.push('aborted resolved'),
    () => outcomes.push('aborted rejected'),
  );

  generation.abort();
  await aborted;

  const current = gate
    .whenReady(new AbortController().signal)
    .then(() => outcomes.push('current resolved'));

  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  await vi.advanceTimersByTimeAsync(0);
  await current;

  expect(outcomes).toEqual(['aborted rejected', 'current resolved']);
});

it('resolves a wait at once when the gate is already open', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);

  fake.handler('session_start')({ reason: 'startup' }, context);
  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  await vi.advanceTimersByTimeAsync(0);

  await expect(gate.whenReady(new AbortController().signal)).resolves.toBeUndefined();
});

it('rejects a wait whose signal aborted before it started, even when the gate is open', async () => {
  const fake = fakeExtensionApi();
  const gate = createStartupGate(fake.pi);
  const generation = new AbortController();

  fake.handler('session_start')({ reason: 'startup' }, context);
  fake.handler('resources_discover')({ type: 'resources_discover' }, context);
  await vi.advanceTimersByTimeAsync(0);
  generation.abort();

  await expect(gate.whenReady(generation.signal)).rejects.toThrow('This operation was aborted');
});
