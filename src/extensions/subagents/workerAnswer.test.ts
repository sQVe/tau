import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { answerPath, formatAnswerReference } from './answerRecord.js';
import type { SavedQuestion } from './assignment.js';
import { answersOpenQuestion, readSavedAnswer } from './workerAnswer.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
const questionId = '7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c';
const otherQuestionId = '9b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const sessionId = '11111111-1111-4111-8111-111111111111';

const question: SavedQuestion = {
  questionId,
  text: 'Which envelope?',
  askedAt: 1_800_000_000_000,
};

const assignment = { assignmentId, questions: [question] };

const saveFixture = (name: string): string => {
  vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(onTestFinished, 'tau-worker-answer-'));

  const path = answerPath(assignmentId, questionId);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  copyFileSync(fileURLToPath(new URL(`./fixtures/answer/${name}`, import.meta.url)), path);

  return path;
};

const inboxMessage = (family: string, content: string) => ({
  customType: 'tau-inbox-message',
  content,
  details: { version: 2, messageId: 'message-1', sessionId, family },
});

const answerMessage = (forQuestion = questionId) =>
  inboxMessage('answer', formatAnswerReference(assignmentId, forQuestion));

it('accepts a delivered answer for the open question', async () => {
  saveFixture('current.json');

  await expect(
    answersOpenQuestion({ assignment, sessionId, message: answerMessage() }),
  ).resolves.toBe(true);
});

it('refuses a handover while the question waits', async () => {
  saveFixture('current.json');

  const message = inboxMessage('handover', formatAnswerReference(assignmentId, questionId));

  await expect(answersOpenQuestion({ assignment, sessionId, message })).resolves.toBe(false);
});

it('refuses an answer for another question', async () => {
  saveFixture('current.json');

  await expect(
    answersOpenQuestion({ assignment, sessionId, message: answerMessage(otherQuestionId) }),
  ).resolves.toBe(false);
});

it('refuses an answer message whose content is not a reference', async () => {
  saveFixture('current.json');

  const message = inboxMessage('answer', 'Use the v2 envelope.');

  await expect(answersOpenQuestion({ assignment, sessionId, message })).resolves.toBe(false);
});

it('refuses a delivered answer with no answer file', async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(onTestFinished, 'tau-worker-answer-'));
  mkdirSync(dirname(dirname(answerPath(assignmentId, questionId))), { recursive: true });

  await expect(
    answersOpenQuestion({ assignment, sessionId, message: answerMessage() }),
  ).resolves.toBe(false);
});

it('refuses a delivered answer with a malformed answer file', async () => {
  saveFixture('malformed.json');

  await expect(
    answersOpenQuestion({ assignment, sessionId, message: answerMessage() }),
  ).resolves.toBe(false);
});

it('returns the path of a saved answer for the open question', async () => {
  const path = saveFixture('current.json');

  await expect(readSavedAnswer(assignment)).resolves.toBe(path);
});

it('returns no path when the open question has no saved answer', async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(onTestFinished, 'tau-worker-answer-'));
  mkdirSync(dirname(dirname(answerPath(assignmentId, questionId))), { recursive: true });

  await expect(readSavedAnswer(assignment)).resolves.toBeUndefined();
});

it('returns no path for a malformed saved answer', async () => {
  saveFixture('malformed.json');

  await expect(readSavedAnswer(assignment)).resolves.toBeUndefined();
});

it('returns no path for an assignment without a question', async () => {
  saveFixture('current.json');

  await expect(readSavedAnswer({ assignmentId, questions: [] })).resolves.toBeUndefined();
});
