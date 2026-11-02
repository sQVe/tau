import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../command.js';
import { assignmentDirectory, readAssignment, saveReport, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { askParent } from './question.js';
import type { QuestionInput, QuestionTarget } from './question.js';

const workerTerminal = 'worker-1';
const parentTerminal = 'manager-1';
const sessionId = '11111111-1111-1111-1111-111111111111';

const setup = () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-question-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);

  const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';

  const assignment: Assignment = {
    version: 2,
    assignmentId,
    task: 'Do the thing.',
    acceptance: [],
    label: null,
    profile: 'worker',
    loadout: fixtureLoadout(directory),
    routing: null,
    packageSnapshot: null,
    session: {
      id: sessionId,
      file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`),
    },
    parentSession: join(directory, 'parent.jsonl'),
    cwd: directory,
    parentTerminal,
    deadline: Date.now() + 60_000,
    createdAt: Date.now(),
    questions: [],
    report: null,
  };

  const fake = createHcFake();

  fake.reply('send', JSON.stringify({ turn: 1 }));

  const target: QuestionTarget = {
    hc: { exec: fake.exec, connect: fake.connect, cwd: directory },
    parent: parentTerminal,
    assignmentPath: join(assignmentDirectory(assignmentId), 'assignment.json'),
    assignment,
  };

  const question: QuestionInput = { question: 'Which config file wins?' };

  return { fake, question, target };
};

const commandCalls = (fake: ReturnType<typeof setup>['fake']) =>
  fake.calls.map((call) => call.commandArguments[0]);

it('keeps the saved question and names the failed note when hc send fails', async () => {
  const { fake, question, target } = setup();

  fake.fail('send', 'send refused', 1);

  await writeAssignment(target.assignment);

  const result = await askParent(target, question);
  const content = result.content[0];

  expect(content?.type === 'text' ? content.text : '').toContain('Question note failed');
  expect(result.terminate).toBe(true);

  const saved = await readAssignment(target.assignmentPath);
  const savedTexts = saved?.questions.map((entry) => entry.text);

  expect(savedTexts).toEqual([question.question]);
  expect(commandCalls(fake)).toEqual(['send']);
});

it('saves and sends nothing for an invalid question', async () => {
  const { fake, target } = setup();

  await writeAssignment(target.assignment);

  await expect(askParent(target, { question: '' })).rejects.toThrow('Malformed question');

  expect((await readAssignment(target.assignmentPath))?.questions).toEqual([]);
  expect(fake.calls).toEqual([]);
});

it('saves the question before it notes the parent', async () => {
  const { fake, question, target } = setup();
  let savedCountWhenNoted: number | undefined;

  const exec: Exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'send') {
      savedCountWhenNoted = (await readAssignment(target.assignmentPath))?.questions.length;
    }

    return fake.exec(command, commandArguments, options);
  };

  await writeAssignment(target.assignment);

  await askParent({ ...target, hc: { ...target.hc, exec } }, question);

  expect(savedCountWhenNoted).toBe(1);
  expect(commandCalls(fake)).toEqual(['send']);
});

it('notes the parent with the assignment path', async () => {
  const { fake, question, target } = setup();

  await writeAssignment(target.assignment);

  await askParent(target, question);

  const sendCall = fake.calls.find((call) => call.commandArguments[0] === 'send');

  expect(sendCall?.commandArguments.at(-1)).toBe(`[tau-question] ${target.assignmentPath}`);
});

it('keeps earlier questions and the report when it asks another question', async () => {
  const { question, target } = setup();
  const report = { outcome: 'success' as const, summary: 'Found it.', evidence: [] };

  await writeAssignment(target.assignment);
  await askParent(target, question);
  await saveReport(target.assignmentPath, report);
  await askParent(target, { question: 'Which branch?' });

  const saved = await readAssignment(target.assignmentPath);

  expect(saved?.questions.map((entry) => entry.text)).toEqual([question.question, 'Which branch?']);
  expect(saved?.report).toEqual(report);
});
