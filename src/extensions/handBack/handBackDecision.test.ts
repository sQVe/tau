import { marked } from 'marked';
import { expect, it } from 'vitest';

import {
  permissionQuestionText,
  proposalApprovalText,
  userCleanupText,
  userStepsText,
} from './fixtures/handBackTexts.js';
import { decideHandBack } from './handBackDecision.js';
import type { HandBackDecision, HandBackFacts } from './handBackDecision.js';

const leadTurn = (overrides: Partial<HandBackFacts> = {}): HandBackFacts => ({
  role: 'lead',
  finalText: 'Implemented the reminder and ran the focused tests. All pass.',
  outcome: 'completed',
  reminded: false,
  ...overrides,
});

const remind: HandBackDecision = { kind: 'remind' };

const settle = (
  reason: Extract<HandBackDecision, { kind: 'settle' }>['reason'],
): HandBackDecision => ({ kind: 'settle', reason });

const table: { name: string; facts: HandBackFacts; expected: HandBackDecision }[] = [
  {
    name: 'reminds for a yes/no permission question about the lead next step',
    facts: leadTurn({ finalText: permissionQuestionText }),
    expected: remind,
  },
  {
    name: 'reminds for a question that waits for approval of a proposal',
    facts: leadTurn({ finalText: proposalApprovalText }),
    expected: remind,
  },
  {
    name: 'reminds for a request that the user runs a command',
    facts: leadTurn({ finalText: userCleanupText }),
    expected: remind,
  },
  {
    name: 'reminds for numbered steps the user must do',
    facts: leadTurn({ finalText: userStepsText }),
    expected: remind,
  },
  {
    name: 'settles for a choice between named alternatives',
    facts: leadTurn({ finalText: 'Which layout do you want, the table or the cards?' }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a permission shape that offers named alternatives',
    facts: leadTurn({ finalText: 'Should I use the table layout or the card layout?' }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a choice phrased as a wish',
    facts: leadTurn({ finalText: 'Would you like the table layout or the card layout?' }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a choice asked through a request',
    facts: leadTurn({
      finalText: 'Could you tell me which layout you want, the table or the cards?',
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a named choice with a trailing predicate',
    facts: leadTurn({
      finalText: 'Could you tell me which layout, the table or the cards, looks better?',
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a named choice after a colon',
    facts: leadTurn({
      finalText: 'Which format should I use for reports: the table or the cards?',
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a report about what is now possible',
    facts: leadTurn({
      finalText: 'The configuration is ready; you can now run the checker without a model API.',
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'reminds for permission with incidental alternatives',
    facts: leadTurn({
      finalText: 'Should I file a ticket for users who cannot sign in on Safari or Firefox?',
    }),
    expected: remind,
  },
  {
    name: 'settles for a permission phrase inside a four-backtick fence',
    facts: leadTurn({
      finalText: [
        'Implemented the change.',
        '',
        '````md',
        '```',
        'Should I delete the branch?',
        '```',
        '````',
      ].join('\n'),
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'reminds for a hand-back after a four-backtick fence',
    facts: leadTurn({
      finalText: [
        'Implemented the change.',
        '',
        '````md',
        '```',
        'Should I delete the branch?',
        '```',
        '````',
        '',
        'Should I delete the branch?',
      ].join('\n'),
    }),
    expected: remind,
  },
  {
    name: 'settles for a permission phrase inside an indented code block',
    facts: leadTurn({
      finalText: ['Implemented the change.', '', '    Should I delete the branch?'].join('\n'),
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a bare named choice',
    facts: leadTurn({ finalText: 'Would you prefer JSON or YAML?' }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a named choice with permission',
    facts: leadTurn({ finalText: 'Should I use JSON or YAML?' }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a capability report without now',
    facts: leadTurn({
      finalText: 'The configuration is ready; you can run the checker without a model API.',
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'reminds for permission after an action and purpose',
    facts: leadTurn({
      finalText:
        'Should I use the tracker to file a ticket for users who cannot sign in on Safari or Firefox?',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a numbered step after a report',
    facts: leadTurn({ finalText: 'The change is ready.\n\n1. Run the checker.' }),
    expected: remind,
  },
  {
    name: 'reminds for a hand-back after a line-start code span',
    facts: leadTurn({
      finalText: '```pnpm check``` passed.\n\nShould I delete the branch?',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a request in a list item',
    facts: leadTurn({ finalText: '- Next step:\n    Please run the checker.' }),
    expected: remind,
  },
  {
    name: 'reminds for a second-person status question',
    facts: leadTurn({
      finalText: 'Could you tell me what the log says, whether the run passed or failed?',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a request before a choice on the same line',
    facts: leadTurn({
      finalText: 'Please run the checker, and would you like the table or the cards?',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a request after a choice on the same line',
    facts: leadTurn({
      finalText: 'Would you like the table or the cards? Please run the checker.',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a request after a choice clause on the same line',
    facts: leadTurn({
      finalText: 'Would you like the table or the cards, and please run the checker?',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a status request with an or',
    facts: leadTurn({ finalText: 'Could you tell me what passed or failed?' }),
    expected: remind,
  },
  {
    name: 'reminds for a request before a comma choice',
    facts: leadTurn({
      finalText: 'Please run the checker, would you prefer JSON or YAML?',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a request after a choice with a bare comma',
    facts: leadTurn({
      finalText: 'Would you prefer JSON or YAML, could you run the checker?',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a request in a preceding sentence',
    facts: leadTurn({
      finalText: 'Please run the checker. Would you prefer JSON or YAML?',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a request before a choice in the same clause',
    facts: leadTurn({
      finalText:
        'Please run the checker to see which format, the table or the cards, looks better?',
    }),
    expected: remind,
  },
  {
    name: 'reminds for a request in another table cell',
    facts: leadTurn({
      finalText: [
        '| Next step |',
        '| --- |',
        '| Please run the checker. |',
        '| Would you prefer JSON or YAML? |',
      ].join('\n'),
    }),
    expected: remind,
  },
  {
    name: 'settles for a soft-wrapped choice',
    facts: leadTurn({ finalText: 'Would you like the table\nor the cards?' }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a hard-wrapped choice',
    facts: leadTurn({ finalText: 'Would you like the table  \nor the cards?' }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'reminds for a soft-wrapped request',
    facts: leadTurn({ finalText: 'Please\nrun the checker.' }),
    expected: remind,
  },
  {
    name: 'settles for a choice with a purpose clause',
    facts: leadTurn({ finalText: 'Would you like me to use the table or the cards?' }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a choice with parallel modifiers',
    facts: leadTurn({
      finalText: 'Would you like the table for reports or the cards for reports?',
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'reminds for an obligation to run',
    facts: leadTurn({ finalText: 'You will need to run the checker.' }),
    expected: remind,
  },
  {
    name: 'settles for a code span request in a table cell',
    facts: leadTurn({
      finalText: ['| Output |', '| --- |', '| `Please run the checker.` |'].join('\n'),
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'reminds for prose in a table cell',
    facts: leadTurn({
      finalText: ['| Next step |', '| --- |', '| Please run the checker. |'].join('\n'),
    }),
    expected: remind,
  },
  {
    name: 'settles for a plain report',
    facts: leadTurn(),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a permission phrase inside a code block',
    facts: leadTurn({
      finalText: [
        'Implemented the change.',
        '',
        '```text',
        'Should I delete the branch?',
        '```',
      ].join('\n'),
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles for a permission phrase inside a block quote',
    facts: leadTurn({
      finalText: ['Implemented the change.', '', '> Should I delete the branch?'].join('\n'),
    }),
    expected: settle('no-hand-back'),
  },
  {
    name: 'settles in an architect session',
    facts: leadTurn({ role: 'architect', finalText: permissionQuestionText }),
    expected: settle('not-lead'),
  },
  {
    name: 'settles in a worker session',
    facts: leadTurn({ role: 'worker', finalText: permissionQuestionText }),
    expected: settle('not-lead'),
  },
  {
    name: 'settles after an errored run',
    facts: leadTurn({ outcome: 'error', finalText: permissionQuestionText }),
    expected: settle('run-failed'),
  },
  {
    name: 'settles after an aborted run',
    facts: leadTurn({ outcome: 'aborted', finalText: permissionQuestionText }),
    expected: settle('run-failed'),
  },
  {
    name: 'settles a failed run with empty text as run-failed',
    facts: leadTurn({ outcome: 'aborted', finalText: '' }),
    expected: settle('run-failed'),
  },
  {
    name: 'settles after one reminder in the same user message',
    facts: leadTurn({ finalText: permissionQuestionText, reminded: true }),
    expected: settle('already-reminded'),
  },
  {
    name: 'settles when there is no final text',
    facts: leadTurn({ finalText: '' }),
    expected: settle('no-text'),
  },
  {
    name: 'settles when the final text is only whitespace',
    facts: leadTurn({ finalText: ' \n\t ' }),
    expected: settle('no-text'),
  },
  {
    name: 'settles for a permission phrase without a question mark',
    facts: leadTurn({ finalText: 'The note says should I file a ticket, but I already filed it.' }),
    expected: settle('no-hand-back'),
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideHandBack(row.facts)).toEqual(row.expected);
});

it('keeps the decision stable when marked options change', () => {
  const defaults = { ...marked.defaults };
  const branch = leadTurn({ finalText: '~~Should I delete the branch?~~' });
  const fence = leadTurn({ finalText: '```sh\nPlease run the checker.\n' });

  expect(decideHandBack(branch)).toEqual(remind);
  expect(decideHandBack(fence)).toEqual(settle('no-text'));

  try {
    marked.setOptions({ gfm: false });
    expect(decideHandBack(branch)).toEqual(remind);

    marked.setOptions({ pedantic: true });
    expect(decideHandBack(fence)).toEqual(settle('no-text'));
  } finally {
    marked.setOptions(defaults);
  }
});
