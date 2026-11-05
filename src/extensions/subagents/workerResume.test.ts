import { mkdirSync } from 'node:fs';

import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { answerPath, publishAnswer } from './answerRecord.js';
import { assignmentDirectory } from './assignment.js';
import type { Assignment, SavedQuestion } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { workerPrompt } from './profiles.js';
import { readSavedAnswer } from './workerAnswer.js';
import { decideWorkerResume, decideWorkerStart } from './workerResume.js';

const entry = (message: unknown, type = 'message') =>
  ({ type, message }) as unknown as SessionEntry;

const user = () => entry({ role: 'user', content: 'An unrelated note.' });

const question = (isError = false) =>
  entry({ role: 'toolResult', toolName: 'subagent_question', isError });

const otherResult = () => entry({ role: 'toolResult', toolName: 'subagent_report' });

const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
const previousAssignmentId = '5e6f7a8b-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const otherAssignmentId = '7d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a';

const assignment = (id: string, previous: string | null): Assignment => ({
  version: 3,
  assignmentId: id,
  task: 'Inspect the fixture.',
  acceptance: [],
  label: null,
  profile: 'worker',
  loadout: fixtureLoadout('/work'),
  routing: null,
  packageSnapshot: null,
  session: { id: previous ?? id, file: '/work/session.jsonl' },
  parentSession: '/work/parent.jsonl',
  cwd: '/work',
  parentTerminal: 'manager',
  deadline: 1_900_000_000_000,
  createdAt: 1_700_000_000_000,
  previousAssignmentId: previous,
  extensionPackages: null,
  questions: [],
  report: null,
});

const first = assignment(assignmentId, null);
const followUp = assignment(assignmentId, previousAssignmentId);

const taskMessage = (id: string) =>
  entry({ role: 'user', content: workerPrompt(assignment(id, null)) });

const taskBlocksMessage = (id: string) =>
  entry({
    role: 'user',
    content: [
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: workerPrompt(assignment(id, null)) },
    ],
  });

const malformedMessage = () => entry({ role: 'user', content: { text: 'not a list' } });

it.each([
  {
    name: 'fresh session sends',
    branch: [],
    assignment: first,
    sendTaskPrompt: true,
    waitingForQuestion: false,
  },
  {
    name: 'first task with a user message skips',
    branch: [user()],
    assignment: first,
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'follow-up resends for its task',
    branch: [user()],
    assignment: followUp,
    sendTaskPrompt: true,
    waitingForQuestion: false,
  },
  {
    name: 'task message for this ID skips',
    branch: [taskMessage(assignmentId)],
    assignment: followUp,
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'task text block for this ID skips',
    branch: [taskBlocksMessage(assignmentId)],
    assignment: followUp,
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'task text block for another ID resends',
    branch: [taskBlocksMessage(otherAssignmentId)],
    assignment: followUp,
    sendTaskPrompt: true,
    waitingForQuestion: false,
  },
  {
    name: 'malformed user content resends',
    branch: [malformedMessage()],
    assignment: followUp,
    sendTaskPrompt: true,
    waitingForQuestion: false,
  },
  {
    name: 'task message for another ID resends',
    branch: [taskMessage(otherAssignmentId)],
    assignment: followUp,
    sendTaskPrompt: true,
    waitingForQuestion: false,
  },
  {
    name: 'waits after a question',
    branch: [user(), question()],
    assignment: first,
    sendTaskPrompt: false,
    waitingForQuestion: true,
  },
  {
    name: 'a user message ends the wait',
    branch: [user(), question(), user()],
    assignment: first,
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'a second question waits again',
    branch: [user(), question(), user(), question()],
    assignment: first,
    sendTaskPrompt: false,
    waitingForQuestion: true,
  },
  {
    name: 'another result does not answer',
    branch: [user(), question(), otherResult()],
    assignment: first,
    sendTaskPrompt: false,
    waitingForQuestion: true,
  },
  {
    name: 'another result is not a question',
    branch: [user(), otherResult()],
    assignment: first,
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'a failed question does not wait',
    branch: [user(), question(true)],
    assignment: first,
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'a non-message is not user text',
    branch: [entry({ role: 'user', content: 'Task' }, 'custom')],
    assignment: first,
    sendTaskPrompt: true,
    waitingForQuestion: false,
  },
] satisfies {
  name: string;
  branch: SessionEntry[];
  assignment: Assignment;
  sendTaskPrompt: boolean;
  waitingForQuestion: boolean;
}[])('$name', ({ branch, assignment: target, sendTaskPrompt, waitingForQuestion }) => {
  expect(decideWorkerResume(branch, target, undefined)).toEqual({
    sendTaskPrompt,
    waitingForQuestion,
    answerPath: undefined,
  });
});

const firstQuestion: SavedQuestion = {
  questionId: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  text: 'Which config file wins?',
  askedAt: 1_800_000_000_000,
};

const secondQuestion: SavedQuestion = {
  questionId: '9b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e',
  text: 'Which test runner?',
  askedAt: 1_800_000_100_000,
};

const inboxMessage = (family: string) =>
  ({
    type: 'custom_message',
    customType: 'tau-inbox-message',
    content: 'A note from the parent.',
    display: true,
    details: { version: 2, messageId: 'message-1', sessionId: assignmentId, family },
  }) as unknown as SessionEntry;

const useAgentDirectory = (): void => {
  vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(onTestFinished, 'tau-worker-resume-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
};

const answer = (saved: SavedQuestion): void => {
  mkdirSync(assignmentDirectory(assignmentId), { recursive: true, mode: 0o700 });

  publishAnswer({
    version: 1,
    assignmentId,
    questionId: saved.questionId,
    answeredAt: saved.askedAt + 1,
    answer: 'Use A.',
  });
};

const resumeWith = async (branch: SessionEntry[], questions: SavedQuestion[]) => {
  const target = { ...first, questions };

  return decideWorkerResume(branch, target, await readSavedAnswer(target));
};

it('keeps waiting when a handover arrives after the question', async () => {
  useAgentDirectory();

  const resume = await resumeWith([user(), question(), inboxMessage('handover')], [firstQuestion]);

  expect(resume.waitingForQuestion).toBe(true);
});

it('ends the wait when the open question has a saved answer', async () => {
  useAgentDirectory();
  answer(firstQuestion);

  const resume = await resumeWith([user(), question()], [firstQuestion]);

  expect(resume).toEqual({
    sendTaskPrompt: false,
    waitingForQuestion: false,
    answerPath: answerPath(assignmentId, firstQuestion.questionId),
  });
});

it('waits again for a second question after an answered one', async () => {
  useAgentDirectory();
  answer(firstQuestion);

  const resume = await resumeWith(
    [user(), question(), inboxMessage('answer'), question()],
    [firstQuestion, secondQuestion],
  );

  expect(resume.waitingForQuestion).toBe(true);
});

const resume = (sendTaskPrompt: boolean, waitingForQuestion: boolean) => ({
  sendTaskPrompt,
  waitingForQuestion,
  answerPath: undefined,
});

it.each([
  {
    name: 'shuts down a fresh worker whose assignment has a report',
    resume: resume(true, false),
    hasReport: true,
    start: 'shutdown',
  },
  {
    name: 'shuts down a reported worker that was waiting for an answer',
    resume: resume(false, true),
    hasReport: true,
    start: 'shutdown',
  },
  {
    name: 'sends the task when the task prompt never went out',
    resume: resume(true, false),
    hasReport: false,
    start: 'sendTask',
  },
  {
    name: 'waits when a question has no answer yet',
    resume: resume(false, true),
    hasReport: false,
    start: 'wait',
  },
  {
    name: 'continues a sent task with no question and no report',
    resume: resume(false, false),
    hasReport: false,
    start: 'continue',
  },
] satisfies {
  name: string;
  resume: ReturnType<typeof resume>;
  hasReport: boolean;
  start: string;
}[])('$name', ({ resume: facts, hasReport, start }) => {
  expect(decideWorkerStart(facts, hasReport)).toBe(start);
});
