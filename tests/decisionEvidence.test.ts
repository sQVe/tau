import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

it.each(['finish-slice', 'pr'])('links shared decision evidence from the %s skill', (skill) => {
  const path = resolve(import.meta.dirname, `../src/skills/${skill}/SKILL.md`);
  const markdown = readFileSync(path, 'utf8');

  expect(markdown).toMatch(/\]\(\.\.\/shared\/decision-evidence\.md(?:#[a-z-]+)?\)/);
});

it.each(['brainstorm', 'slice', 'start-slice'])(
  'links planning decision evidence from the %s skill',
  (skill) => {
    const path = resolve(import.meta.dirname, `../src/skills/${skill}/SKILL.md`);
    const markdown = readFileSync(path, 'utf8');

    expect(markdown).toContain('](../shared/decision-evidence.md#plan-the-change)');
  },
);
