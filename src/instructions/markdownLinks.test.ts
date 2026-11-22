import { expect, it } from 'vitest';

import { readMarkdownLinks } from './markdownLinks.js';

const targetTable: { name: string; markdown: string; expected: readonly string[] }[] = [
  {
    name: 'reads inline and angle targets',
    markdown: '[a](./a.md) [b](<./b c.md#Top>)',
    expected: ['./a.md', './b c.md#Top'],
  },
  {
    name: 'reads an image target',
    markdown: '![alt](./gone.png)',
    expected: ['./gone.png'],
  },
  {
    name: 'keeps document order across links and definitions',
    markdown: '[a](./one.md)\n\n[b]: ./two.md\n\n[c](./three.md)\n',
    expected: ['./one.md', './two.md', './three.md'],
  },
  {
    name: 'reads a definition with a title',
    markdown: '[b]: ./titled.md "Title"',
    expected: ['./titled.md'],
  },
  {
    name: 'reads a definition whose target is on the next line',
    markdown: '[b]:\n  ./next-line.md',
    expected: ['./next-line.md'],
  },
  {
    name: 'reads a target inside a quote',
    markdown: '> [q](./quote.md)',
    expected: ['./quote.md'],
  },
  {
    name: 'reads a target inside a list item',
    markdown: '- [l](./list.md)',
    expected: ['./list.md'],
  },
  {
    name: 'reads a definition inside a blockquote',
    markdown: '> [a]: ./quoted-definition.md',
    expected: ['./quoted-definition.md'],
  },
  {
    name: 'reads a definition inside a list item',
    markdown: '- [a]: ./listed-definition.md',
    expected: ['./listed-definition.md'],
  },
  {
    name: 'reads no target from a fence',
    markdown: '```\n[x](./fence.md)\n```',
    expected: [],
  },
  {
    name: 'reads no target from a code span',
    markdown: '`[x](./span.md)`',
    expected: [],
  },
  {
    name: 'reads no target from an HTML comment',
    markdown: '<!-- [x](./comment.md) -->',
    expected: [],
  },
  {
    name: 'reads no target from indented code',
    markdown: '    [x](./indent.md)',
    expected: [],
  },
  {
    name: 'reads no target from an unclosed link',
    markdown: '[x](./oops.md trailing prose',
    expected: [],
  },
  {
    name: 'reads no target from a line that only looks like a definition',
    markdown: '[Note]: this is important',
    expected: [],
  },
  {
    name: 'reads no target from a definition with trailing words',
    markdown: '[a]: ./missing.md trailing words',
    expected: [],
  },
  {
    name: 'keeps percent encoding',
    markdown: '[e](./release%20notes.md)',
    expected: ['./release%20notes.md'],
  },
  {
    name: 'reads a definition split across CRLF lines',
    markdown: '[adr]:\r\n  ./coding.md\r\n',
    expected: ['./coding.md'],
  },
];

it.for(targetTable)('$name', ({ markdown, expected }) => {
  expect(readMarkdownLinks(markdown).targets).toEqual(expected);
});

const slugTable: { name: string; markdown: string; expected: readonly string[] }[] = [
  {
    name: 'reads ATX and Setext heading slugs',
    markdown: '# One\n\nTwo\n---\n\n### Three',
    expected: ['one', 'two', 'three'],
  },
  {
    name: 'numbers repeated slugs and skips a taken number',
    markdown: '# Notes\n\n## Notes\n\n### Notes-1',
    expected: ['notes', 'notes-1', 'notes-1-1'],
  },
  {
    name: 'numbers a third repeated slug',
    markdown: '# Notes\n\n# Notes\n\n# Notes\n',
    expected: ['notes', 'notes-1', 'notes-2'],
  },
  {
    name: 'reads the text of a code span in a heading',
    markdown: '# Run `pnpm check` now',
    expected: ['run-pnpm-check-now'],
  },
  {
    name: 'drops link markup and punctuation from a slug',
    markdown: '## [Linked](../README.md) heading, with punctuation!',
    expected: ['linked-heading-with-punctuation'],
  },
  {
    name: 'reads a heading after a byte order mark',
    markdown: '\uFEFF# Top',
    expected: ['top'],
  },
  {
    name: 'reads the rendered text of a reference link in a heading',
    markdown: '# [Foo][id]\n\n[id]: ./good.md\n',
    expected: ['foo'],
  },
  {
    name: 'keeps an unresolved reference link in a heading as text',
    markdown: '# [Foo][missing]\n',
    expected: ['foomissing'],
  },
  {
    name: 'drops emphasis, escapes, images, and HTML from a slug',
    markdown: '# _Emph_ and **bold** ![img](x.png) <b>tag</b> \\_x\\_\n',
    expected: ['emph-and-bold--tag-_x_'],
  },
];

it.for(slugTable)('$name', ({ markdown, expected }) => {
  expect([...readMarkdownLinks(markdown).slugs]).toEqual(expected);
});
