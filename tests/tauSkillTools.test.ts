import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

import { skillTools } from '../src/skillTools.js';

it('has a SKILL.md for each skill in skillTools', () => {
  for (const skill of Object.keys(skillTools)) {
    const skillFile = resolve(import.meta.dirname, '../src/skills', skill, 'SKILL.md');

    expect(existsSync(skillFile)).toBe(true);
  }
});
