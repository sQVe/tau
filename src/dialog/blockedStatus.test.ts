import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Component, ProgramStatus, TUI } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import { customWithBlockedStatus } from './blockedStatus.js';

type Factory = (...args: unknown[]) => Component | Promise<Component>;

const blocked = { kind: 'permission', message: 'Write to Linear?' } as const;

const blockedReport = {
  state: 'blocked',
  app: 'pi',
  kind: 'permission',
  message: 'Write to Linear?',
};

const working = { state: 'working', app: 'pi', message: 'session name' };
const noop = () => undefined;
const component = {} as Component;

const throwingFactory = () => {
  throw new Error('factory failed');
};

const refusing = async () => {
  throw new Error('no UI');
};

const contextWith = (custom: unknown) =>
  ({
    ui: { custom },
    sessionManager: { getSessionName: () => 'session name' },
  }) as unknown as ExtensionContext;

const terminalFor = (reports: ProgramStatus[]) =>
  ({
    terminal: { setProgramStatus: (status: ProgramStatus) => reports.push(status) },
  }) as unknown as TUI;

it('writes blocked when the dialog opens and working when it resolves', async () => {
  const reports: ProgramStatus[] = [];

  const custom = async (factory: Factory) => {
    await factory(terminalFor(reports), undefined, undefined, noop);

    return 'yes';
  };

  const result = await customWithBlockedStatus(contextWith(custom), blocked, () => component);

  expect(result).toBe('yes');
  expect(reports).toEqual([blockedReport, working]);
});

it('writes working and rethrows when the factory throws', async () => {
  const reports: ProgramStatus[] = [];

  const custom = async (factory: Factory) =>
    factory(terminalFor(reports), undefined, undefined, noop);

  await expect(
    customWithBlockedStatus(contextWith(custom), blocked, throwingFactory),
  ).rejects.toThrow('factory failed');

  expect(reports).toEqual([blockedReport, working]);
});

it('writes working and rethrows when the dialog promise rejects', async () => {
  const reports: ProgramStatus[] = [];

  const custom = async (factory: Factory) => {
    await factory(terminalFor(reports), undefined, undefined, noop);

    throw new Error('dialog lost');
  };

  await expect(
    customWithBlockedStatus(contextWith(custom), blocked, () => component),
  ).rejects.toThrow('dialog lost');

  expect(reports).toEqual([blockedReport, working]);
});

it('leaves the open count alone when Pi never calls the factory', async () => {
  const reports: ProgramStatus[] = [];

  await expect(
    customWithBlockedStatus(contextWith(refusing), blocked, () => component),
  ).rejects.toThrow('no UI');

  const answering = async (factory: Factory) => {
    await factory(terminalFor(reports), undefined, undefined, noop);

    return 'yes';
  };

  await customWithBlockedStatus(contextWith(answering), blocked, () => component);

  expect(reports).toEqual([blockedReport, working]);
});

it('writes one blocked and one working for a nested Tau dialog', async () => {
  const reports: ProgramStatus[] = [];

  const custom = async (factory: Factory) => {
    await factory(terminalFor(reports), undefined, undefined, noop);

    return 'answer';
  };

  const context = contextWith(custom);

  await customWithBlockedStatus(context, blocked, async () => {
    await customWithBlockedStatus(context, blocked, () => component);

    return component;
  });

  expect(reports).toEqual([blockedReport, working]);
});
