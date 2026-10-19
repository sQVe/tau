import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished as afterTest, vi } from 'vitest';

import { writeWorkerActivity } from '../activity.js';
import { recordEvent } from '../records.js';
import { setup } from './fixtures/controllerFixture.js';

afterEach(() => {
  vi.useRealTimers();
});

const launchedRow = async (
  onTestFinished: (callback: () => void) => void,
  activity:
    | { updatedAtOffset: number; label?: string; description?: string; model?: string }
    | undefined,
) => {
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);

  if (activity !== undefined) {
    const updatedAt = Date.now() + activity.updatedAtOffset;

    writeWorkerActivity(launched.directory, {
      taskId: launched.taskId,
      sequence: 1,
      updatedAt,
      phase: 'active',
      ...(activity.label === undefined ? {} : { label: activity.label }),
      ...(activity.model === undefined ? {} : { model: activity.model }),
      ...(activity.description === undefined
        ? {}
        : { description: activity.description, descriptionAt: updatedAt }),
    });
  }

  const row = () => fixture.controller.widgetRows(fixture.input.parentSessionId)[0];

  return { fixture, launched, row };
};

it('shows the latest tool label when the worker reported no phase', async ({ onTestFinished }) => {
  const { row } = await launchedRow(onTestFinished, {
    updatedAtOffset: 0,
    label: 'tool: read',
  });

  expect(row()?.activity).toBe('tool: read');
});

it.each([
  ['an empty label', { updatedAtOffset: 0, label: '' }],
  ['no label', { updatedAtOffset: 0 }],
  ['a label older than a minute', { updatedAtOffset: -90_000, label: 'tool: read' }],
  ['a label from the future', { updatedAtOffset: 30_000, label: 'tool: read' }],
])('does not show current work for %s', async (_name, activity) => {
  const { row } = await launchedRow(afterTest, activity);

  expect(row()?.activity).not.toBe('tool: read');
  expect(row()?.activity).toMatch(/\S/u);
});

it('shows the worker phase while the worker runs', async ({ onTestFinished }) => {
  const { launched, row } = await launchedRow(onTestFinished, {
    updatedAtOffset: 0,
    description: 'Fixing status counts',
  });

  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

  expect(row()?.state).toBe('running');
  expect(row()?.activity).toBe('Fixing status counts');
});

it('reports an unknown state when the worker records cannot be read', async ({
  onTestFinished,
}) => {
  const { launched, row } = await launchedRow(onTestFinished, undefined);

  writeFileSync(join(launched.directory, 'report.json'), '{');

  expect(row()?.state).toBe('unknown');
  expect(row()?.activity).not.toBe('tool: read');
});

it.each([
  ['at the moment it is reported', 0, true],
  ['just under a minute old', -59_999, true],
  ['exactly a minute old', -60_000, false],
])('treats activity %s as the right freshness', async (_name, ageOffset, shownAsCurrent) => {
  const { fixture, launched } = await launchedRow(afterTest, undefined);

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_800_000_000_000);

  writeWorkerActivity(launched.directory, {
    taskId: launched.taskId,
    sequence: 1,
    updatedAt: Date.now() + ageOffset,
    phase: 'active',
    label: 'tool: read',
  });

  const activity = fixture.controller.widgetRows(fixture.input.parentSessionId)[0]?.activity;

  expect(activity === 'tool: read').toBe(shownAsCurrent);
});

it('shows the model the worker reported while its activity is current', async ({
  onTestFinished,
}) => {
  const { fixture, row } = await launchedRow(onTestFinished, {
    updatedAtOffset: 0,
    label: 'tool: read',
    model: 'openai/gpt-observed',
  });

  expect(row()?.observedModel).toBe('openai/gpt-observed');
  expect(row()?.requestedModel).toBe(fixture.input.loadout.model);
});

it.each([
  ['no model', { updatedAtOffset: 0, label: 'tool: read' }],
  ['an empty model', { updatedAtOffset: 0, label: 'tool: read', model: '' }],
  ['a model from stale activity', { updatedAtOffset: -90_000, model: 'openai/gpt-observed' }],
])('shows no observed model for %s', async (_name, activity) => {
  const { row } = await launchedRow(afterTest, activity);

  expect(row()).not.toHaveProperty('observedModel');
});

it('leaves out the label when the task has none', async ({ onTestFinished }) => {
  const { row } = await launchedRow(onTestFinished, undefined);

  expect(row()).not.toHaveProperty('label');
});
