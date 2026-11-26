import { expect, it } from 'vitest';

import { decisionsSectionName, summaryHasHeading } from './reportSections.js';

const table: { name: string; summary: string; expected: boolean }[] = [
  {
    name: 'ignores a Decisions heading inside a fenced block',
    summary: ['Changes: None', '```markdown', '## Decisions', '```', 'Concerns: None'].join('\n'),
    expected: false,
  },
  {
    name: 'ignores a Decisions heading inside a tilde fence',
    summary: ['Changes: None', '~~~', '## Decisions', '~~~', 'Concerns: None'].join('\n'),
    expected: false,
  },
  {
    name: 'ignores a Decisions heading inside a fenced block in a blockquote',
    summary: ['> ```', '> ## Decisions', '> ```'].join('\n'),
    expected: false,
  },
  {
    name: 'ignores a Decisions heading inside a fenced block in a list item',
    summary: ['- item', '  ```', '  ## Decisions', '  ```'].join('\n'),
    expected: false,
  },
  {
    name: 'ignores a Decisions heading inside an indented code block',
    summary: '    ## Decisions',
    expected: false,
  },
  {
    name: 'ignores a Decisions heading inside an inline codespan',
    summary: 'Example: `## Decisions`',
    expected: false,
  },
  {
    name: 'ignores a link label that reads Decisions',
    summary: '## Evidence\nSee [Decisions](./reviewer.md) for the design notes.',
    expected: false,
  },
  {
    name: 'ignores a table cell that reads Decisions',
    summary: '## Evidence\n\n| Area | Verdict |\n| --- | --- |\n| Decisions | none |',
    expected: false,
  },
  {
    name: 'accepts a real Decisions heading',
    summary: ['## Changes', 'None', '## Decisions', 'None', '## Concerns', 'None'].join('\n'),
    expected: true,
  },
  {
    name: 'accepts a Decisions heading with closing hashes',
    summary: '## Decisions ##',
    expected: true,
  },
  {
    name: 'accepts a Decisions heading whose label is a link',
    summary: '## [Decisions](./reviewer.md)',
    expected: true,
  },
  {
    name: 'accepts a Decisions paragraph',
    summary: 'Decisions: None',
    expected: true,
  },
  {
    name: 'accepts a compact four-label Decisions paragraph',
    summary: ['Changes: None', 'Evidence: None', 'Decisions: None', 'Concerns: None'].join('\n'),
    expected: true,
  },
  {
    name: 'accepts a setext Decisions heading',
    summary: 'Decisions\n===',
    expected: true,
  },
  {
    name: 'accepts a Decisions list item',
    summary: '- Decisions: None',
    expected: true,
  },
  {
    name: 'accepts a Decisions blockquote',
    summary: '> Decisions: None',
    expected: true,
  },
  {
    name: 'accepts a bold Decisions label',
    summary: '**Decisions:** None',
    expected: true,
  },
  {
    name: 'accepts a real Decisions heading next to a fenced heading',
    summary: ['```', '## Decisions', '```', '', '## Decisions', 'None'].join('\n'),
    expected: true,
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(summaryHasHeading(row.summary, decisionsSectionName)).toBe(row.expected);
});
