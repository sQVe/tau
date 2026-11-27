import { beforeEach, describe, expect, it } from 'vitest';

import {
  analyzeProse,
  checkProse,
  proseCharacterCensus,
  proseCharacterClass,
  proseSentences,
} from './prose.js';
import type { ProseCharacterClass, ProseFinding } from './prose.js';

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
    name: 'trims a trailing space from the excerpt',
    markdown: 'A pause—then more&nbsp;',
    expected: [{ rule: 'emDash', line: 1, excerpt: 'A pause—then more' }],
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
    name: 'sorts same-line findings by rule order',
    markdown: `A—b. ${words(41, '.')}`,
    expected: [
      { rule: 'longSentence', line: 1, excerpt: cut(words(41, '.')) },
      { rule: 'emDash', line: 1, excerpt: 'A—b.' },
    ],
  },
  {
    name: 'cuts long excerpts',
    markdown: words(60, '.'),
    expected: [{ rule: 'longSentence', line: 1, excerpt: cut(words(60, '.')) }],
  },
  {
    name: 'checks prose after deeply nested quotes',
    markdown: `${'>'.repeat(4096)}\n\n${'> '.repeat(4096)}\n\nOrdinary prose—here.`,
    expected: [{ rule: 'emDash', line: 5, excerpt: 'Ordinary prose—here.' }],
  },
  {
    name: 'flags a sentence after a soft line break',
    markdown: 'First.\nSecond—third.',
    expected: [{ rule: 'emDash', line: 2, excerpt: 'Second—third.' }],
  },
  {
    name: 'flags a sentence after a hard line break',
    markdown: 'First.  \nSecond—third.',
    expected: [{ rule: 'emDash', line: 2, excerpt: 'Second—third.' }],
  },
  {
    name: 'decodes an encoded em dash',
    markdown: 'A pause&mdash;then more.',
    expected: [{ rule: 'emDash', line: 1, excerpt: 'A pause—then more.' }],
  },
  {
    name: 'decodes a numeric em dash',
    markdown: 'A pause&#8212;then more.',
    expected: [{ rule: 'emDash', line: 1, excerpt: 'A pause—then more.' }],
  },
  {
    name: 'decodes an encoded curly quote',
    markdown: 'A &rsquo;quote.',
    expected: [{ rule: 'curlyQuote', line: 1, excerpt: 'A ’quote.' }],
  },
  {
    name: 'decodes the open curly quote alias',
    markdown: 'A &OpenCurlyQuote;quote.',
    expected: [{ rule: 'curlyQuote', line: 1, excerpt: 'A \u2018quote.' }],
  },
  {
    name: 'decodes the close curly quote alias',
    markdown: 'A &CloseCurlyQuote;quote.',
    expected: [{ rule: 'curlyQuote', line: 1, excerpt: 'A \u2019quote.' }],
  },
  {
    name: 'decodes the open curly double quote alias',
    markdown: 'A &OpenCurlyDoubleQuote;quote.',
    expected: [{ rule: 'curlyQuote', line: 1, excerpt: 'A \u201Cquote.' }],
  },
  {
    name: 'decodes the close curly double quote alias',
    markdown: 'A &CloseCurlyDoubleQuote;quote.',
    expected: [{ rule: 'curlyQuote', line: 1, excerpt: 'A \u201Dquote.' }],
  },
  {
    name: 'counts an encoded non-breaking space as a word break',
    markdown: `${words(39)} word&nbsp;word.`,
    expected: [{ rule: 'longSentence', line: 1, excerpt: cut(`${words(39)} word\u00A0word.`) }],
  },
  {
    name: 'decodes the non-breaking space alias as a word break',
    markdown: `${words(40)}&NonBreakingSpace;word.`,
    expected: [{ rule: 'longSentence', line: 1, excerpt: cut(`${words(40)}\u00A0word.`) }],
  },
  {
    name: 'skips encoded entities in fenced code',
    markdown: fenced(['A&mdash;B.', '&rsquo;', words(50, '.')]),
    expected: [],
  },
  {
    name: 'drops an image with prose-like alt text',
    markdown: 'See ![a—b](image.png) here.',
    expected: [],
  },
  {
    name: 'drops multiline inline HTML',
    markdown: 'See <span\n title="a—b">here.',
    expected: [],
  },
  {
    name: 'orders findings on different lines by line',
    markdown: `A—b.\n\n${words(41, '.')}`,
    expected: [
      { rule: 'emDash', line: 1, excerpt: 'A—b.' },
      { rule: 'longSentence', line: 3, excerpt: cut(words(41, '.')) },
    ],
  },
  {
    name: 'keeps text inside emphasis',
    markdown: 'A **pause—then** more.',
    expected: [{ rule: 'emDash', line: 1, excerpt: 'A pause—then more.' }],
  },
  {
    name: 'skips a code span inside a tight list item',
    markdown: '- `a—b` text',
    expected: [],
  },
  {
    name: 'counts repeated whitespace as one word break',
    markdown: `${Array.from({ length: 40 }, () => 'word').join('  ')}.`,
    expected: [],
  },
  {
    name: 'skips prose inside deeply nested quotes',
    markdown: `${'> '.repeat(4096)}A—b.\n\nOrdinary prose—here.`,
    expected: [{ rule: 'emDash', line: 3, excerpt: 'Ordinary prose—here.' }],
  },
  {
    name: 'decodes a hexadecimal em dash',
    markdown: 'A pause&#x2014;then more.',
    expected: [{ rule: 'emDash', line: 1, excerpt: 'A pause—then more.' }],
  },
  {
    name: 'keeps a malformed numeric entity literal',
    markdown: 'A pause&#x2014ZZ;then more.',
    expected: [],
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

it('returns the sentences and findings of one walk', () => {
  const markdown = `A pause—then more.\n\n${words(41, '.')}`;

  expect(analyzeProse(markdown)).toEqual({
    sentences: [
      { text: 'A pause—then more.', line: 1, words: 3 },
      { text: words(41, '.'), line: 3, words: 41 },
    ],
    findings: [
      { rule: 'emDash', line: 1, excerpt: 'A pause—then more.' },
      { rule: 'longSentence', line: 3, excerpt: cut(words(41, '.')) },
    ],
  });
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
  {
    name: 'joins a soft line break with a space',
    markdown: 'One\ntwo.',
    expected: [{ text: 'One two.', line: 1, words: 2 }],
  },
  {
    name: 'reads CRLF lines',
    markdown: 'One.\r\n\r\nTwo.',
    expected: [
      { text: 'One.', line: 1, words: 1 },
      { text: 'Two.', line: 3, words: 1 },
    ],
  },
  {
    name: 'reads sentences after a soft line break',
    markdown: 'First.\nSecond—third.',
    expected: [
      { text: 'First.', line: 1, words: 1 },
      { text: 'Second—third.', line: 2, words: 1 },
    ],
  },
  {
    name: 'reads the line of a sentence between two soft line breaks',
    markdown: 'First.\nSecond.\nThird—fourth.',
    expected: [
      { text: 'First.', line: 1, words: 1 },
      { text: 'Second.', line: 2, words: 1 },
      { text: 'Third—fourth.', line: 3, words: 1 },
    ],
  },
  {
    name: 'reads sentences after a hard line break',
    markdown: 'First.  \nSecond—third.',
    expected: [
      { text: 'First.', line: 1, words: 1 },
      { text: 'Second—third.', line: 2, words: 1 },
    ],
  },
  {
    name: 'splits on exclamation and question marks',
    markdown: 'Stop! Next? Done.',
    expected: [
      { text: 'Stop!', line: 1, words: 1 },
      { text: 'Next?', line: 1, words: 1 },
      { text: 'Done.', line: 1, words: 1 },
    ],
  },
  {
    name: 'keeps an escaped character',
    markdown: 'Use \\*star\\* now.',
    expected: [{ text: 'Use *star* now.', line: 1, words: 3 }],
  },
  {
    name: 'reads an email autolink as a URL',
    markdown: 'Write user@example.com now.',
    expected: [{ text: 'Write url now.', line: 1, words: 3 }],
  },
  {
    name: 'drops an image alt text',
    markdown: 'See ![a—b](image.png) here.',
    expected: [{ text: 'See  here.', line: 1, words: 2 }],
  },
  {
    name: 'reads text without multiline HTML',
    markdown: 'See <span\n title="a—b">here.',
    expected: [{ text: 'See here.', line: 1, words: 2 }],
  },
  {
    name: 'keeps an unknown or malformed entity literal',
    markdown: 'A &unknown; &constructor; &#xZZ; here.',
    expected: [{ text: 'A &unknown; &constructor; &#xZZ; here.', line: 1, words: 5 }],
  },
  {
    name: 'reads a formatted tight list item',
    markdown: '- `a—b` text',
    expected: [{ text: 'code text', line: 1, words: 2 }],
  },
  {
    name: 'replaces an out-of-range numeric entity with U+FFFD',
    markdown: 'A &#x110000; here.',
    expected: [{ text: 'A \uFFFD here.', line: 1, words: 3 }],
  },
  {
    name: 'keeps an out-of-range numeric entity literal inside raw inline HTML',
    markdown: 'A <code>&#x110000;</code> B.',
    expected: [{ text: 'A &#x110000; B.', line: 1, words: 3 }],
  },
  {
    name: 'decodes the last code point',
    markdown: 'A &#x10FFFF; here.',
    expected: [{ text: `A ${String.fromCodePoint(0x10ffff)} here.`, line: 1, words: 3 }],
  },
  {
    name: 'keeps a malformed numeric entity in the sentence text',
    markdown: 'A pause&#x2014ZZ;then more.',
    expected: [{ text: 'A pause&#x2014ZZ;then more.', line: 1, words: 3 }],
  },
];

it.each(sentenceTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(proseSentences(row.markdown)).toEqual(row.expected);
});

describe('prose character classification', () => {
  beforeEach(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  });

  const letterBoundaries: readonly (readonly [string, string])[] = [
    ['A', 'Z'],
    ['a', 'z'],
    ['\u00c0', '\u00d6'],
    ['\u00d8', '\u00f6'],
    ['\u0391', '\u03a9'],
    ['\u03b1', '\u03c9'],
    ['\u0400', '\u04ff'],
    ['\u05d0', '\u05ea'],
    ['\u0621', '\u064a'],
    ['\u0915', '\u0939'],
    ['\u0e01', '\u0e30'],
    ['\u3041', '\u3096'],
    ['\u30a1', '\u30fa'],
    ['\u4e00', '\u9fff'],
  ];

  it.each(letterBoundaries)('classifies %s through %s as letters', (first, last) => {
    expect(proseCharacterClass(first)).toBe('letter');
    expect(proseCharacterClass(last)).toBe('letter');
  });

  const characterTable: readonly (readonly [string, ProseCharacterClass])[] = [
    ['0', 'digit'],
    ['9', 'digit'],
    [' ', 'space'],
    ['\t', 'space'],
    ['\n', 'space'],
    ['\r', 'space'],
    ['-', 'dash'],
    ['\u2013', 'dash'],
    ['\u2014', 'dash'],
    ['"', 'quote'],
    ["'", 'quote'],
    ['`', 'quote'],
    ['\u2018', 'quote'],
    ['\u2019', 'quote'],
    ['\u201c', 'quote'],
    ['\u201d', 'quote'],
    ['.', 'terminal'],
    ['!', 'terminal'],
    ['?', 'terminal'],
    ['(', 'bracket'],
    [')', 'bracket'],
    ['[', 'bracket'],
    [']', 'bracket'],
    ['{', 'bracket'],
    ['}', 'bracket'],
    ['\u00a1', 'symbol'],
    ['\u00bf', 'symbol'],
    ['@', 'other'],
    ['\uffff', 'other'],
  ];

  it.each(characterTable)('classifies %j as %s', (character, expected) => {
    expect(proseCharacterClass(character)).toBe(expected);
  });

  it('counts characters by class', () => {
    expect(proseCharacterCensus('A1 b—c?')).toEqual({
      total: 7,
      letters: 3,
      digits: 1,
      spaces: 1,
      punctuation: 2,
      other: 0,
    });
  });

  it('counts an empty text as zero of every class', () => {
    expect(proseCharacterCensus('')).toEqual({
      total: 0,
      letters: 0,
      digits: 0,
      spaces: 0,
      punctuation: 0,
      other: 0,
    });
  });

  it('counts an unclassified character as other', () => {
    expect(proseCharacterCensus('@')).toEqual({
      total: 1,
      letters: 0,
      digits: 0,
      spaces: 0,
      punctuation: 0,
      other: 1,
    });
  });
});
