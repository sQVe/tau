import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import type { MessageRequest } from '../../inbox/inbox.js';
import { workerAnswerRefusal } from './workerAnswer.js';
import type { AnswerAssignment } from './workerAnswer.js';

const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
const otherAssignmentId = '7d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a';
const openQuestionId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const earlierQuestionId = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const parentSession = '/work/parent.jsonl';

const question = (questionId: string) => ({ questionId, text: 'Which?', askedAt: 1 });

const asked: AnswerAssignment = {
  assignmentId,
  parentSession,
  questions: [question(earlierQuestionId), question(openQuestionId)],
  report: null,
};

const reported: AnswerAssignment = {
  ...asked,
  report: { outcome: 'success', summary: 'Done.', evidence: [] },
};

const unasked: AnswerAssignment = { ...asked, questions: [] };

const answer = (
  changes: Partial<Extract<MessageRequest, { family: 'answer' }>['payload']> = {},
  messageId = changes.questionId ?? openQuestionId,
): Extract<MessageRequest, { family: 'answer' }> => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId,
  targetTerminal: 'worker',
  targetSessionId: '11111111-1111-4111-8111-111111111111',
  family: 'answer',
  payload: {
    assignmentId,
    questionId: openQuestionId,
    parentSession,
    answer: 'Use A.',
    ...changes,
  },
});

const delivered = (questionId: string, content: string) =>
  ({
    type: 'custom_message',
    customType: 'tau-inbox-message',
    content,
    display: true,
    details: { version: 2, messageId: questionId, sessionId: 's', family: 'answer', questionId },
  }) as unknown as SessionEntry;

it.each([
  { name: 'open question', assignment: asked, request: answer(), branch: [], refused: undefined },
  {
    name: 'repeat of a shown answer',
    assignment: asked,
    request: answer(),
    branch: [delivered(openQuestionId, 'Use A.')],
    refused: undefined,
  },
  {
    name: 'no loaded assignment',
    assignment: undefined,
    request: answer(),
    branch: [],
    refused: 'This worker has no loaded assignment.',
  },
  {
    name: 'other assignment',
    assignment: asked,
    request: answer({ assignmentId: otherAssignmentId }),
    branch: [],
    refused: `This worker runs assignment ${assignmentId}, not ${otherAssignmentId}.`,
  },
  {
    name: 'other manager',
    assignment: asked,
    request: answer({ parentSession: '/other/parent.jsonl' }),
    branch: [],
    refused: `Assignment ${assignmentId} belongs to another manager.`,
  },
  {
    name: 'saved report',
    assignment: reported,
    request: answer(),
    branch: [],
    refused: `Assignment ${assignmentId} already has a report.`,
  },
  {
    name: 'earlier question',
    assignment: asked,
    request: answer({ questionId: earlierQuestionId }),
    branch: [],
    refused: `Question ${earlierQuestionId} is not the open question of assignment ${assignmentId}.`,
  },
  {
    name: 'no question',
    assignment: unasked,
    request: answer(),
    branch: [],
    refused: `Question ${openQuestionId} is not the open question of assignment ${assignmentId}.`,
  },
  {
    name: 'other message ID',
    assignment: asked,
    request: answer({}, earlierQuestionId),
    branch: [],
    refused: `An answer to question ${openQuestionId} must use the question ID as its message ID.`,
  },
  {
    name: 'different shown answer',
    assignment: asked,
    request: answer(),
    branch: [delivered(openQuestionId, 'Use B.')],
    refused: `Question ${openQuestionId} already has another answer.`,
  },
  {
    name: 'answer to an earlier question',
    assignment: asked,
    request: answer(),
    branch: [delivered(earlierQuestionId, 'Use B.')],
    refused: undefined,
  },
] satisfies {
  name: string;
  assignment: AnswerAssignment | undefined;
  request: Extract<MessageRequest, { family: 'answer' }>;
  branch: SessionEntry[];
  refused: string | undefined;
}[])('$name', ({ assignment, request, branch, refused }) => {
  expect(workerAnswerRefusal({ assignment, request, branch })).toBe(refused);
});
