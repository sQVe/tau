import { expect, it } from 'vitest';

import { checkProse, proseSentences } from './prose.js';
import type { ProseFinding } from './prose.js';

const words = (count: number, end = ''): string =>
  `${Array.from({ length: count }, () => 'word').join(' ')}${end}`;

const cut = (text: string): string => `${text.slice(0, 100)}...`;

const fenced = (lines: readonly string[]): string => ['```', ...lines, '```'].join('\n');

const table: {
  name: string;
  markdown: string;
  expected: ProseFinding[];
}[] = [
  {
    name: 'flags a 41-word sentence and not a 40-word one',
    markdown: `${words(40, '.')}\n\n${words(41, '.')}`,
    expected: [{ rule: 'longSentence', line: 3, excerpt: cut(words(41, '.')) }],
  },
  {
    name: 'flags an em dash',
    markdown: 'A pause—then more.',
    expected: [{ rule: 'emDash', line: 1, excerpt: 'A pause—then more.' }],
  },
  {
    name: 'flags the left single curly quote',
    markdown: 'A \u2018quote.',
    expected: [{ rule: 'curlyQuote', line: 1, excerpt: 'A \u2018quote.' }],
  },
  {
    name: 'flags the right single curly quote',
    markdown: 'A \u2019quote.',
    expected: [{ rule: 'curlyQuote', line: 1, excerpt: 'A \u2019quote.' }],
  },
  {
    name: 'flags the left double curly quote',
    markdown: 'A \u201Cquote.',
    expected: [{ rule: 'curlyQuote', line: 1, excerpt: 'A \u201Cquote.' }],
  },
  {
    name: 'flags the right double curly quote',
    markdown: 'A \u201Dquote.',
    expected: [{ rule: 'curlyQuote', line: 1, excerpt: 'A \u201Dquote.' }],
  },
  {
    name: 'gives one finding per rule per sentence',
    markdown: 'A pause—then more—and more.',
    expected: [{ rule: 'emDash', line: 1, excerpt: 'A pause—then more—and more.' }],
  },
  {
    name: 'skips fenced code blocks',
    markdown: fenced(['A pause—then more.', words(50, '.')]),
    expected: [],
  },
  {
    name: 'skips an em dash inside inline code',
    markdown: 'A `pause—then` more.',
    expected: [],
  },
  {
    name: 'counts a code span as one word in a 40-word sentence',
    markdown: `${words(39)} \`x\`.`,
    expected: [],
  },
  {
    name: 'counts a code span as one word in a 41-word sentence',
    markdown: `${words(40)} \`x\`.`,
    expected: [{ rule: 'longSentence', line: 1, excerpt: cut(`${words(40)} code.`) }],
  },
  {
    name: 'skips URLs',
    markdown: 'See <https://example.com/a—b> here.\n\nSee https://example.com/a’b here.',
    expected: [],
  },
  {
    name: 'skips quote blocks',
    markdown: '> A quoted—line.',
    expected: [],
  },
  {
    name: 'splits list items and headings',
    markdown: `# ${words(30)}\n\n- ${words(30)}\n- ${words(30)}`,
    expected: [],
  },
  {
    name: 'keeps an explicit link label',
    markdown: 'See [the guide](https://x.dev)—now.',
    expected: [{ rule: 'emDash', line: 1, excerpt: 'See the guide—now.' }],
  },
  {
    name: 'drops a same-label URL',
    markdown: '[https://x.dev/a—b](https://x.dev/a—b) is here.',
    expected: [],
  },
  {
    name: 'reports table cell lines',
    markdown: '| First | Second |\n| ----- | ------ |\n| plain | text |\n| dash | a—b |',
    expected: [{ rule: 'emDash', line: 4, excerpt: 'a—b' }],
  },
  {
    name: 'reports the starting line',
    markdown: '# Title\n\nFirst sentence. Second—sentence.',
    expected: [{ rule: 'emDash', line: 3, excerpt: 'Second—sentence.' }],
  },
  {
    name: 'cuts long excerpts',
    markdown: words(60, '.'),
    expected: [{ rule: 'longSentence', line: 1, excerpt: cut(words(60, '.')) }],
  },
  {
    name: 'returns no findings for empty text',
    markdown: '',
    expected: [],
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(checkProse(row.markdown)).toEqual(row.expected);
});

const sentenceTable: {
  name: string;
  markdown: string;
  expected: { text: string; line: number; words: number }[];
}[] = [
  {
    name: 'reads paragraph lines and word counts',
    markdown: 'One two three.\n\nFour five.',
    expected: [
      { text: 'One two three.', line: 1, words: 3 },
      { text: 'Four five.', line: 3, words: 2 },
    ],
  },
  {
    name: 'reads heading and list item lines',
    markdown: '# Head\n\n- one two\n- three',
    expected: [
      { text: 'Head', line: 1, words: 1 },
      { text: 'one two', line: 3, words: 2 },
      { text: 'three', line: 4, words: 1 },
    ],
  },
  {
    name: 'reads table cell lines',
    markdown: '| a |\n| - |\n| b |\n| c |',
    expected: [
      { text: 'a', line: 1, words: 1 },
      { text: 'b', line: 3, words: 1 },
      { text: 'c', line: 4, words: 1 },
    ],
  },
  {
    name: 'counts a code span as one word',
    markdown: 'Use `a b c` now.',
    expected: [{ text: 'Use code now.', line: 1, words: 3 }],
  },
];

it.each(sentenceTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(proseSentences(row.markdown)).toEqual(row.expected);
});
