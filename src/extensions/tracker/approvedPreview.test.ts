import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { approvedPreviewLines, approvesCancel } from './approvedPreview.js';
import {
  answer,
  askCall,
  askResult,
  cancelOption,
  entry,
  question,
  user,
} from './fixtures/approvedPreview.js';

const approvedBranch = (preview = 'Cancel ME-1: Title') => [
  askCall('call-1', [question([cancelOption(preview)])]),
  askResult('call-1', [answer]),
];

const table: { name: string; branch: SessionEntry[]; expected: boolean }[] = [
  {
    name: 'an approval preview with the ticket and title gives true',
    branch: approvedBranch('Cancel ME-1: Title'),
    expected: true,
  },
  { name: 'a bare cancel line gives true', branch: approvedBranch('Cancel ME-1'), expected: true },
  {
    name: 'a preview for another ticket gives false',
    branch: approvedBranch('Cancel ME-2: Title'),
    expected: false,
  },
  {
    name: 'a Keep option whose question preview holds the line gives false',
    branch: [
      askCall('call-1', [question([{ label: 'Keep' }], { preview: 'Cancel ME-1: Title' })]),
      askResult('call-1', [{ question: 'Cancel the ticket?', selected: ['Keep'], typed: false }]),
    ],
    expected: false,
  },
  {
    name: 'a typed answer gives false',
    branch: [
      askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
      askResult('call-1', [{ ...answer, typed: true }]),
    ],
    expected: false,
  },
  {
    name: 'a decided result gives false',
    branch: [
      askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
      askResult('call-1', [answer], { details: { kind: 'decided', answers: [answer] } }),
    ],
    expected: false,
  },
  {
    name: 'an error result gives false',
    branch: [
      askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
      askResult('call-1', [answer], { isError: true }),
    ],
    expected: false,
  },
  {
    name: 'a choice question gives false',
    branch: [
      askCall('call-1', [question([cancelOption('Cancel ME-1: Title')], { kind: 'choice' })]),
      askResult('call-1', [answer]),
    ],
    expected: false,
  },
  {
    name: 'an approval before the latest user message gives false',
    branch: [...approvedBranch(), user()],
    expected: false,
  },
  {
    name: 'an approval after the latest user message gives true',
    branch: [user(), ...approvedBranch()],
    expected: true,
  },
  {
    name: 'a result with no matching tool call gives false',
    branch: [
      askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
      askResult('call-2', [answer]),
    ],
    expected: false,
  },
  {
    name: 'an answer without typed gives false',
    branch: [
      askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
      askResult('call-1', [{ question: 'Cancel the ticket?', selected: ['Cancel it'] }]),
    ],
    expected: false,
  },
  {
    name: 'two questions with the same text give false',
    branch: [
      askCall('call-1', [
        question([cancelOption('Cancel ME-1: Title')]),
        question([cancelOption('Cancel ME-1: Title')]),
      ]),
      askResult('call-1', [answer]),
    ],
    expected: false,
  },
  {
    name: 'two options with the same selected label give false',
    branch: [
      askCall('call-1', [
        question([cancelOption('Cancel ME-1: Title'), cancelOption('Cancel ME-1: Title')]),
      ]),
      askResult('call-1', [answer]),
    ],
    expected: false,
  },
  {
    name: 'a branch with no user message gives true',
    branch: approvedBranch(),
    expected: true,
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { branch, expected }) => {
  expect(approvesCancel(approvedPreviewLines(branch), 'ME-1')).toBe(expected);
});

it('duplicate tool call ids give no lines', () => {
  const branch = [
    askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
    askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
    askResult('call-1', [answer]),
  ];

  expect(approvesCancel(approvedPreviewLines(branch), 'ME-1')).toBe(false);
});

it('a mixed selection with one duplicated label gives no lines', () => {
  const branch = [
    askCall('call-1', [
      question([
        cancelOption('Cancel ME-1: Title'),
        cancelOption('Cancel ME-1: Title'),
        { label: 'Keep', preview: 'Cancel ME-1: Title' },
      ]),
    ]),
    askResult('call-1', [
      { question: 'Cancel the ticket?', selected: ['Cancel it', 'Keep'], typed: false },
    ]),
  ];

  expect(approvesCancel(approvedPreviewLines(branch), 'ME-1')).toBe(false);
});

it('a selected label that is not a string gives no lines', () => {
  const branch = [
    askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
    askResult('call-1', [
      { question: 'Cancel the ticket?', selected: [5, 'Cancel it'], typed: false },
    ]),
  ];

  expect(approvesCancel(approvedPreviewLines(branch), 'ME-1')).toBe(false);
});

it('approves each identifier a preview lists', () => {
  const branch = approvedBranch('Cancel ME-1: A\nCancel ME-2: B');
  const lines = approvedPreviewLines(branch);

  expect(approvesCancel(lines, 'ME-1')).toBe(true);
  expect(approvesCancel(lines, 'ME-2')).toBe(true);
  expect(approvesCancel(lines, 'ME-3')).toBe(false);
});

it('trims preview lines before matching', () => {
  const branch = approvedBranch('  Cancel ME-1: Title  ');

  expect(approvesCancel(approvedPreviewLines(branch), 'ME-1')).toBe(true);
});

it('gives each selected preview in order and skips an unselected one', () => {
  const branch = [
    askCall('call-1', [
      question(
        [
          { label: 'Cancel ME-1', preview: 'Cancel ME-1: First' },
          { label: 'Cancel ME-2', preview: 'Cancel ME-2: Second\nCancel ME-2: Extra' },
          { label: 'Cancel ME-3', preview: 'Cancel ME-3: Third' },
        ],
        { multiSelect: true },
      ),
    ]),
    askResult('call-1', [
      { question: 'Cancel the ticket?', selected: ['Cancel ME-1', 'Cancel ME-2'], typed: false },
    ]),
  ];

  const lines = approvedPreviewLines(branch);

  expect(lines).toEqual(['Cancel ME-1: First', 'Cancel ME-2: Second', 'Cancel ME-2: Extra']);

  expect(approvesCancel(lines, 'ME-3')).toBe(false);
});

it('gives no lines when a result arrives before its matching call', () => {
  const branch = [
    askResult('call-1', [answer]),
    askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
  ];

  expect(approvedPreviewLines(branch)).toEqual([]);
});

it('keeps emitted lines when a duplicate call arrives after an accepted result', () => {
  const branch = [
    askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
    askResult('call-1', [answer]),
    askCall('call-1', [question([cancelOption('Cancel ME-2: Title')])]),
    askResult('call-1', [answer]),
  ];

  expect(approvedPreviewLines(branch)).toEqual(['Cancel ME-1: Title']);
});

it('an unrelated tool result neither adds nor removes lines', () => {
  const branch = [
    askCall('call-1', [
      question([cancelOption('Cancel ME-1: Title'), { label: 'Keep', preview: 'Cancel ME-2' }]),
    ]),
    entry({
      role: 'toolResult',
      toolName: 'bash',
      toolCallId: 'call-1',
      isError: false,
      details: {
        kind: 'answered',
        answers: [{ question: 'Cancel the ticket?', selected: ['Keep'], typed: false }],
      },
    }),
    askResult('call-1', [answer]),
  ];

  expect(approvedPreviewLines(branch)).toEqual(['Cancel ME-1: Title']);
});

it('a question-shaped call from another tool gives no lines', () => {
  const branch = [
    askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
    askResult('call-1', [answer]),
    entry({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-2',
          name: 'other_tool',
          arguments: { questions: [question([cancelOption('Cancel ME-2: Title')])] },
        },
      ],
    }),
    askResult('call-2', [answer]),
  ];

  expect(approvedPreviewLines(branch)).toEqual(['Cancel ME-1: Title']);
});

it('a selected label that matches no option gives no lines', () => {
  const branch = [
    askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
    askResult('call-1', [{ question: 'Cancel the ticket?', selected: ['Keep'], typed: false }]),
  ];

  expect(approvedPreviewLines(branch)).toEqual([]);
});

it('an answer whose question text matches no question gives no lines', () => {
  const branch = [
    askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
    askResult('call-1', [{ question: 'Another question?', selected: ['Cancel it'], typed: false }]),
  ];

  expect(approvedPreviewLines(branch)).toEqual([]);
});

it('a malformed call that shares a valid id gives no lines', () => {
  const branch = [
    askCall('call-1', [question([cancelOption('Cancel ME-1: Title')])]),
    entry({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'ask_user_question', arguments: {} }],
    }),
    askResult('call-1', [answer]),
  ];

  expect(approvedPreviewLines(branch)).toEqual([]);
});

it('gives no lines for malformed entries', () => {
  const malformed = [
    { type: 'custom' },
    entry(null),
    entry('text'),
    entry({ role: 'assistant', content: 'text' }),
    entry({ role: 'assistant', content: [null, { type: 'toolCall' }] }),
    entry({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'ask_user_question', arguments: {} }],
    }),
    entry({
      role: 'toolResult',
      toolName: 'ask_user_question',
      toolCallId: 'call-1',
      details: 'answered',
    }),
    entry({
      role: 'toolResult',
      toolName: 'ask_user_question',
      toolCallId: 'call-1',
      details: { kind: 'answered', answers: 'text' },
    }),
    askCall('call-2', [question([{ label: 'Cancel it', preview: 5 }])]),
    askResult('call-2', [{ question: 'Cancel the ticket?', selected: 'Cancel it', typed: false }]),
    askResult('call-2', [{ question: 'Cancel the ticket?', selected: [5], typed: false }]),
  ] as unknown as SessionEntry[];

  expect(approvedPreviewLines(malformed)).toEqual([]);
});
