import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

const skillDirectory = resolve(import.meta.dirname, '../src/skills/code-quality');
const assignment = readFileSync(resolve(skillDirectory, 'quality-assignment.md'), 'utf8');
const criteria = readFileSync(resolve(skillDirectory, 'structure-criteria.md'), 'utf8');

const brainstorm = readFileSync(
  resolve(import.meta.dirname, '../src/skills/brainstorm/SKILL.md'),
  'utf8',
);

const startSlice = readFileSync(
  resolve(import.meta.dirname, '../src/skills/start-slice/SKILL.md'),
  'utf8',
);

const lensStart = '## Quality lens\n\n```markdown\n';

const lensBlock = (markdown: string): string => {
  const start = markdown.indexOf(lensStart) + lensStart.length;
  const end = markdown.indexOf('\n```', start);

  return markdown.slice(start, end);
};

const outsideLens = (markdown: string): string => {
  const start = markdown.indexOf(lensStart);
  const end = markdown.indexOf('\n```', start + lensStart.length) + 4;

  return markdown.slice(0, start) + markdown.slice(end);
};

// A criterion is a numbered line followed by indented bullets, which tells it apart from the lens's
// flat numbered report order whatever its wording.
const criterionNumbers = (text: string): string[] =>
  [...text.matchAll(/^(\d+)\. .*(?:\n {3}(?!- ).*)*\n {3}- /gm)].map((match) => match[1] ?? '');

it('keeps the numbered criteria in structure-criteria.md and out of the lens', () => {
  expect(criterionNumbers(lensBlock(assignment))).toEqual([]);

  expect(criterionNumbers(criteria)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
});

it('links structure-criteria.md for the manager, outside the worker lens', () => {
  expect(outsideLens(assignment)).toContain('](structure-criteria.md)');
});

it('links structure-criteria.md from the brainstorm skill', () => {
  expect(brainstorm).toContain('](../code-quality/structure-criteria.md)');
});

it('links structure-criteria.md from the start-slice skill', () => {
  expect(startSlice).toContain('](../code-quality/structure-criteria.md)');
});
