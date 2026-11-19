import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { writeStommeProject } from '../../../tests/stommeProjectHarness.js';
import { codingSetText } from '../../instructions/guideRuns.js';
import { readInstructionSet } from '../../instructions/instructions.js';
import type { InstructionSetName } from '../../instructions/instructions.js';
import { resolveStommeGuides } from '../../instructions/stommeGuides/stommeGuides.js';
import { writeAssignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { assignmentFor, savePassingFullCheck, setup } from './fixtures/workerExtensionHarness.js';

type Fixture = ReturnType<typeof setup>;

const startWorker = async (fixture: Fixture, instructionSets: InstructionSetName[]) => {
  const { context, directory, pi } = fixture;
  const assignment = assignmentFor(directory);

  await writeAssignment({
    ...assignment,
    loadout: { ...fixtureLoadout(directory), instructionSets },
  });

  await savePassingFullCheck(directory);
  await pi.handler('session_start')({}, context);
};

const startRun = async ({ context, pi }: Fixture): Promise<string> => {
  const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools: [] } };

  for (const handler of pi.handlers.get('before_agent_start') ?? []) {
    await handler(event as never, context);
  }

  return event.systemPromptOptions.appendSystemPrompt;
};

const breakGuides = async (directory: string): Promise<void> => {
  await writeStommeProject(directory, { language: 'rust' });
  await rm(join(directory, 'docs', 'stomme', '.sync-record.toml'));
};

const brokenGuideNotices = ({ context }: Fixture): string[] =>
  vi
    .mocked(context.ui.notify)
    .mock.calls.filter(([message, level]) => level === 'error' && message.includes('stomme coding'))
    .map(([message]) => message);

it('appends the instruction sets and the coding guides of the loadout to each run', async () => {
  const fixture = setup();

  await startWorker(fixture, ['writing', 'coding', 'workflow']);

  const prompt = await startRun(fixture);
  const guides = codingSetText(await resolveStommeGuides(fixture.directory));

  const sets = [await readInstructionSet('writing'), guides, await readInstructionSet('workflow')];

  expect(prompt).toContain(`\n\n${sets.join('\n\n')}`);
  expect(prompt.startsWith('Work on the assigned task.')).toBe(true);
  expect(await startRun(fixture)).toBe(prompt);
});

it('leaves out the coding guides when the loadout has no coding set', async () => {
  const fixture = setup();

  await startWorker(fixture, ['writing']);

  const prompt = await startRun(fixture);
  const guides = codingSetText(await resolveStommeGuides(fixture.directory));

  expect(prompt).toContain(await readInstructionSet('writing'));
  expect(prompt).not.toContain(guides);
});

it('shows a broken guides notice to a worker with the coding set', async () => {
  const fixture = setup();

  await breakGuides(fixture.directory);
  await startWorker(fixture, ['writing', 'coding', 'workflow']);
  await startRun(fixture);

  expect(brokenGuideNotices(fixture)).toHaveLength(1);
});

it('shows no broken guides notice to a worker without the coding set', async () => {
  const fixture = setup();

  await breakGuides(fixture.directory);
  await startWorker(fixture, ['writing']);
  await startRun(fixture);

  expect(brokenGuideNotices(fixture)).toEqual([]);
});

it('shows no broken guides notice before the worker has an assignment', async () => {
  const fixture = setup();

  await breakGuides(fixture.directory);
  await fixture.pi.handler('session_start')({}, fixture.context);
  await startRun(fixture);

  expect(brokenGuideNotices(fixture)).toEqual([]);
});
