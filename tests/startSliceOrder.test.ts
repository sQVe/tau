import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

const skillFile = resolve(import.meta.dirname, '../src/skills/start-slice/SKILL.md');

const finalStep = (markdown: string): string => {
  const start = markdown.indexOf('\n11. ');
  const end = markdown.indexOf('\n## ', start);

  return markdown.slice(start, end);
};

const linkedSkills = (text: string): string[] =>
  [...text.matchAll(/\]\(\.\.\/([a-z-]+)\/SKILL\.md\)/g)].map((match) => match[1] ?? '');

it('runs code-quality, then code-review, then finish-slice, then pr after the workers', () => {
  const step = finalStep(readFileSync(skillFile, 'utf8'));

  expect(linkedSkills(step)).toEqual(['code-quality', 'code-review', 'finish-slice', 'pr']);
});
