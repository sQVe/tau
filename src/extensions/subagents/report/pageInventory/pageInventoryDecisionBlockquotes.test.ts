import { expect, it } from 'vitest';

import {
  contradictingInbox,
  element,
  inventory,
  inventoryPath,
  page,
  summaryWithHeading,
  unresolvedMessage,
} from './fixtures/pageInventoryTestHelpers.js';
import { decidePageInventoryGate } from './pageInventoryDecision.js';
import { nestedDecisionsMessage } from './pageInventoryRefusal.js';

it.each([
  {
    name: 'accepts a finding under a blockquoted Decisions heading',
    facts: {
      profile: 'qa',
      appUrl: true,
      read: contradictingInbox,
      summary: summaryWithHeading(
        '> ## Decisions',
        '- Your inbox card: still visible after removal.',
        true,
      ),
      evidence: [],
    },
    expected: { status: 'accept' },
  },
  {
    name: 'accepts a finding inside a blockquoted Decisions heading',
    facts: {
      profile: 'qa',
      appUrl: true,
      read: contradictingInbox,
      summary: [
        'Checked.',
        '## Changes',
        'None',
        '## Evidence',
        `page inventory: ${inventoryPath}`,
        '> ## Decisions\n>\n> - Your inbox card: still visible after removal.',
        '## Concerns',
        'None',
      ].join('\n\n'),
      evidence: [],
    },
    expected: { status: 'accept' },
  },
  {
    name: 'keeps a deeper heading inside a blockquoted Decisions section',
    facts: {
      profile: 'qa',
      appUrl: true,
      read: contradictingInbox,
      summary: [
        'Checked.',
        '## Changes',
        'None',
        '## Evidence',
        `page inventory: ${inventoryPath}`,
        ['> ## Decisions', '> None', '> ### Details', '> - Your inbox card: still visible.'].join(
          '\n',
        ),
        '## Concerns',
        'None',
      ].join('\n\n'),
      evidence: [],
    },
    expected: { status: 'accept' },
  },
  {
    name: 'accepts a finding under a blockquoted Decisions list item',
    facts: {
      profile: 'qa',
      appUrl: true,
      read: contradictingInbox,
      summary: [
        'Checked.',
        '## Changes',
        'None',
        '## Evidence',
        `page inventory: ${inventoryPath}`,
        '> - Decisions:\n>\n> - Your inbox card: still visible after removal.',
        '## Concerns',
        'None',
      ].join('\n\n'),
      evidence: [],
    },
    expected: { status: 'accept' },
  },
  {
    name: 'accepts an all-matches inventory with a doubly nested Decisions heading',
    facts: {
      profile: 'qa',
      appUrl: true,
      read: inventory([page('https://app.test/teams', [element('Team list', 'matches')])]),
      summary: summaryWithHeading('> > ## Decisions', 'None', true),
      evidence: [],
    },
    expected: { status: 'accept' },
  },
  {
    name: 'refuses a doubly nested blockquoted Decisions heading',
    facts: {
      profile: 'qa',
      appUrl: true,
      read: contradictingInbox,
      summary: summaryWithHeading(
        '> > ## Decisions',
        '- Your inbox card: still visible after removal.',
        true,
      ),
      evidence: [],
    },
    expected: { status: 'refuse', message: nestedDecisionsMessage },
  },
  {
    name: 'refuses a finding under a heading inside a blockquoted Decisions section',
    facts: {
      profile: 'qa',
      appUrl: true,
      read: contradictingInbox,
      summary: [
        'Checked.',
        '## Changes',
        'None',
        '## Evidence',
        `page inventory: ${inventoryPath}`,
        '> ## Decisions\n>\n> None\n>\n> ## Concerns\n>\n> - Your inbox card: still visible.',
        '## Concerns',
        'None',
      ].join('\n\n'),
      evidence: [],
    },
    expected: { status: 'refuse', message: unresolvedMessage },
  },
])('$name', ({ facts, expected }) => {
  expect(
    decidePageInventoryGate({
      ...facts,
      inventoryPath,
    }),
  ).toEqual(expected);
});
