import { expect, it } from 'vitest';

import { element, page } from './fixtures/pageInventoryTestHelpers.js';
import { parsePageInventory } from './pageInventory.js';

it.each([
  {
    name: 'parses pages and elements',
    text: [
      '# Page inventory',
      '',
      'https://app.test/settings/notifications',
      '- Page title: Notification settings: contradicts',
      '- Notification settings form: visible: matches',
      '',
      'https://app.test/teams',
      '- Your inbox card: removed: contradicts',
    ].join('\n'),
    expected: {
      status: 'valid',
      pages: [
        page('https://app.test/settings/notifications', [
          element('Page title', 'contradicts', 'Notification settings'),
          element('Notification settings form', 'matches'),
        ]),
        page('https://app.test/teams', [element('Your inbox card', 'contradicts', 'removed')]),
      ],
    },
  },
  {
    name: 'parses an inventory with bare carriage-return line endings',
    text: ['https://app.test/teams', '- Your inbox card: removed: contradicts'].join('\r'),
    expected: {
      status: 'valid',
      pages: [
        page('https://app.test/teams', [element('Your inbox card', 'contradicts', 'removed')]),
      ],
    },
  },
  {
    name: 'parses an inventory with CRLF line endings',
    text: [
      'https://app.test/teams',
      '- Your inbox card: removed: contradicts',
      '- Form: visible: matches',
    ].join('\r\n'),
    expected: {
      status: 'valid',
      pages: [
        page('https://app.test/teams', [
          element('Your inbox card', 'contradicts', 'removed'),
          element('Form', 'matches'),
        ]),
      ],
    },
  },
  {
    name: 'reports the line of a two-part element',
    text: ['https://app.test/teams', '- Your inbox card: contradicts'].join('\n'),
    expected: { status: 'malformed', line: 2, problem: { kind: 'element' } },
  },
  {
    name: 'trims spaces around an indented page and its element',
    text: ['  https://app.test/teams  ', '   -   Your inbox card :  removed :  contradicts  '].join(
      '\n',
    ),
    expected: {
      status: 'valid',
      pages: [
        page('https://app.test/teams', [element('Your inbox card', 'contradicts', 'removed')]),
      ],
    },
  },
  {
    name: 'reads an expected state that contains a colon',
    text: [
      'https://app.test/settings',
      '- Page title: text: Notification settings: contradicts',
    ].join('\n'),
    expected: {
      status: 'valid',
      pages: [
        page('https://app.test/settings', [
          element('Page title', 'contradicts', 'text: Notification settings'),
        ]),
      ],
    },
  },
  {
    name: 'reports an element with no element text',
    text: ['https://app.test/teams', '- : removed: matches'].join('\n'),
    expected: { status: 'malformed', line: 2, problem: { kind: 'element' } },
  },
  {
    name: 'reports an element with no expected state',
    text: ['https://app.test/teams', '- Your inbox card: : matches'].join('\n'),
    expected: { status: 'malformed', line: 2, problem: { kind: 'element' } },
  },
  {
    name: 'reports the line and text of an unknown verdict',
    text: ['https://app.test/teams', '- Your inbox card: removed: broken'].join('\n'),
    expected: { status: 'malformed', line: 2, problem: { kind: 'verdict', verdict: 'broken' } },
  },
  {
    name: 'reports the line of an element before any page',
    text: '- Your inbox card: removed: contradicts',
    expected: { status: 'malformed', line: 1, problem: { kind: 'placement' } },
  },
  {
    name: 'reports a page line that is not a URL',
    text: ['Settings page', '- Form: visible: matches'].join('\n'),
    expected: { status: 'malformed', line: 1, problem: { kind: 'page' } },
  },
  {
    name: 'reports a page line whose URL contains internal whitespace',
    text: 'https://app.test/teams copied from the browser',
    expected: { status: 'malformed', line: 1, problem: { kind: 'page' } },
  },
  {
    name: 'parses an HTTP page',
    text: ['http://app.test/teams', '- Form: visible: matches'].join('\n'),
    expected: {
      status: 'valid',
      pages: [page('http://app.test/teams', [element('Form', 'matches')])],
    },
  },
  {
    name: 'reports a page that is not HTTP or HTTPS',
    text: ['ftp://app.test/teams', '- Form: visible: matches'].join('\n'),
    expected: { status: 'malformed', line: 1, problem: { kind: 'page' } },
  },
  {
    name: 'reports a malformed bullet instead of a page',
    text: ['https://app.test/teams', '-Account status: visible: broken'].join('\n'),
    expected: { status: 'malformed', line: 2, problem: { kind: 'element' } },
  },
  {
    name: 'reports a star bullet without a space as an element attempt',
    text: ['https://app.test/teams', '*Account status: visible: broken'].join('\n'),
    expected: { status: 'malformed', line: 2, problem: { kind: 'element' } },
  },
  {
    name: 'reports a plus bullet without a space as an element attempt',
    text: ['https://app.test/teams', '+Account status: visible: broken'].join('\n'),
    expected: { status: 'malformed', line: 2, problem: { kind: 'element' } },
  },
])('$name', ({ text, expected }) => {
  expect(parsePageInventory(text)).toEqual(expected);
});
