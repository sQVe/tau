import { expect, it } from 'vitest';

import { askQuestions, askResultOf } from './askResult.ts';
import type { AskQuestion, AskResult } from './askResult.ts';

const message = (fields: Record<string, unknown>) => ({
  role: 'toolResult',
  toolName: 'ask_user_question',
  ...fields,
});

const answer = { question: 'Cancel the ticket?', selected: ['Cancel it'], typed: false };

const resultTable: { name: string; message: Record<string, unknown>; expected: AskResult }[] = [
  {
    name: 'an error result is error even with answered details',
    message: message({ isError: true, details: { kind: 'answered', answers: [answer] } }),
    expected: { kind: 'error' },
  },
  {
    name: 'a decided result is decided',
    message: message({ details: { kind: 'decided' } }),
    expected: { kind: 'decided' },
  },
  {
    name: 'an answered result keeps the call id and answers',
    message: message({ toolCallId: 'call-1', details: { kind: 'answered', answers: [answer] } }),
    expected: { kind: 'answered', callId: 'call-1', answers: [answer] },
  },
  {
    name: 'an answered result without a call id keeps it undefined',
    message: message({ details: { kind: 'answered', answers: [] } }),
    expected: { kind: 'answered', callId: undefined, answers: [] },
  },
  {
    name: 'non-record answers are dropped',
    message: message({
      toolCallId: 'call-1',
      details: { kind: 'answered', answers: [null, 'text', 5, answer] },
    }),
    expected: { kind: 'answered', callId: 'call-1', answers: [answer] },
  },
  {
    name: 'a non-string selected is undefined',
    message: message({
      toolCallId: 'call-1',
      details: {
        kind: 'answered',
        answers: [{ question: 'Q?', selected: [5, 'Cancel it'], typed: false }],
      },
    }),
    expected: {
      kind: 'answered',
      callId: 'call-1',
      answers: [{ question: 'Q?', selected: undefined, typed: false }],
    },
  },
  {
    name: 'a non-array selected is undefined',
    message: message({
      toolCallId: 'call-1',
      details: {
        kind: 'answered',
        answers: [{ question: 'Q?', selected: 'Cancel it', typed: false }],
      },
    }),
    expected: {
      kind: 'answered',
      callId: 'call-1',
      answers: [{ question: 'Q?', selected: undefined, typed: false }],
    },
  },
  {
    name: 'an answer without string fields keeps them undefined',
    message: message({
      toolCallId: 'call-1',
      details: {
        kind: 'answered',
        answers: [{ question: 5, selected: ['Cancel it'], typed: 'yes' }],
      },
    }),
    expected: {
      kind: 'answered',
      callId: 'call-1',
      answers: [{ question: undefined, selected: ['Cancel it'], typed: undefined }],
    },
  },
  {
    name: 'a declined result is other',
    message: message({ details: { kind: 'declined' } }),
    expected: { kind: 'other' },
  },
  {
    name: 'unreadable details are other',
    message: message({ details: 'answered' }),
    expected: { kind: 'other' },
  },
  {
    name: 'an answered result without an answers array is other',
    message: message({ details: { kind: 'answered' } }),
    expected: { kind: 'other' },
  },
  {
    name: 'a missing details value is other',
    message: message({}),
    expected: { kind: 'other' },
  },
];

it.each(resultTable.map((row) => [row.name, row] as const))(
  'askResultOf: %s',
  (_name, { message: input, expected }) => {
    expect(askResultOf(input)).toEqual(expected);
  },
);

it.each([
  { name: 'a user message', input: { role: 'user', toolName: 'ask_user_question' } },
  { name: 'a result of another tool', input: { role: 'toolResult', toolName: 'other' } },
  { name: 'a result without a tool name', input: { role: 'toolResult' } },
  { name: 'an assistant message', input: { role: 'assistant', toolName: 'ask_user_question' } },
])('askResultOf gives no result for $name', ({ input }) => {
  expect(askResultOf(input)).toBeUndefined();
});

const questionTable: {
  name: string;
  parameters: Record<string, unknown> | undefined;
  expected: AskQuestion[];
}[] = [
  {
    name: 'a normal question keeps its kind and options',
    parameters: {
      questions: [
        {
          question: 'Cancel the ticket?',
          kind: 'approval',
          options: [{ label: 'Cancel it', preview: 'Cancel ME-1: Title' }],
        },
      ],
    },
    expected: [
      {
        question: 'Cancel the ticket?',
        kind: 'approval',
        options: [{ label: 'Cancel it', preview: 'Cancel ME-1: Title' }],
      },
    ],
  },
  {
    name: 'a question-level preview never appears on an option',
    parameters: {
      questions: [
        {
          question: 'Cancel the ticket?',
          preview: 'Cancel ME-1: Title',
          options: [{ label: 'Keep' }],
        },
      ],
    },
    expected: [
      {
        question: 'Cancel the ticket?',
        kind: undefined,
        options: [{ label: 'Keep', preview: undefined }],
      },
    ],
  },
  {
    name: 'options without a string label are dropped',
    parameters: {
      questions: [
        {
          question: 'Cancel the ticket?',
          options: [null, { preview: 'Cancel ME-1: Title' }, { label: 5 }, { label: 'Keep' }],
        },
      ],
    },
    expected: [
      {
        question: 'Cancel the ticket?',
        kind: undefined,
        options: [{ label: 'Keep', preview: undefined }],
      },
    ],
  },
  {
    name: 'a non-string option preview is undefined',
    parameters: {
      questions: [{ question: 'Cancel the ticket?', options: [{ label: 'Keep', preview: 5 }] }],
    },
    expected: [
      {
        question: 'Cancel the ticket?',
        kind: undefined,
        options: [{ label: 'Keep', preview: undefined }],
      },
    ],
  },
  {
    name: 'a non-array options value is undefined',
    parameters: { questions: [{ question: 'Cancel the ticket?', options: 'Keep' }] },
    expected: [{ question: 'Cancel the ticket?', kind: undefined, options: undefined }],
  },
  {
    name: 'entries without a string question are dropped',
    parameters: {
      questions: [null, 'text', { question: 5 }, { question: 'Cancel the ticket?' }],
    },
    expected: [{ question: 'Cancel the ticket?', kind: undefined, options: undefined }],
  },
  {
    name: 'a non-string kind is undefined',
    parameters: { questions: [{ question: 'Cancel the ticket?', kind: 5 }] },
    expected: [{ question: 'Cancel the ticket?', kind: undefined, options: undefined }],
  },
  {
    name: 'missing questions give no questions',
    parameters: {},
    expected: [],
  },
  {
    name: 'non-array questions give no questions',
    parameters: { questions: 'Cancel the ticket?' },
    expected: [],
  },
  {
    name: 'missing parameters give no questions',
    parameters: undefined,
    expected: [],
  },
];

it.each(questionTable.map((row) => [row.name, row] as const))(
  'askQuestions: %s',
  (_name, { parameters, expected }) => {
    expect(askQuestions(parameters)).toEqual(expected);
  },
);
