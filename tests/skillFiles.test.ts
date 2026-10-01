import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { findSkillProblems } from './skillFiles.js';
import type { SkillProblemKind } from './skillFiles.js';

const skillsDirectory = join(import.meta.dirname, '..', 'skills');

const validFrontmatter = (name: string) =>
  `---\nname: ${name}\ndescription: Does a thing. Use when asked.\n---\n`;

const createSkills = async (skills: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), 'tau-skill-files-'));
  const directory = join(root, 'skills');

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'docs', 'adr'), { recursive: true });
  await writeFile(join(root, 'docs', 'adr', '0004.md'), '# ADR 0004\n');

  for (const [name, content] of Object.entries(skills)) {
    await mkdir(join(directory, name), { recursive: true });
    await writeFile(join(directory, name, 'SKILL.md'), content);
  }

  return directory;
};

it('finds no problems in the Tau skills', () => {
  expect(findSkillProblems(skillsDirectory)).toEqual([]);
});

it.each<[string, string, SkillProblemKind]>([
  [
    'an ADR link',
    `${validFrontmatter('demo')}Read [the rule](../../docs/adr/0004.md).\n`,
    'adr-reference',
  ],
  [
    'an ADR link in a code block',
    `${validFrontmatter('demo')}\`\`\`markdown\n[rule](../../docs/adr/0004.md)\n\`\`\`\n`,
    'adr-reference',
  ],
  ['an ADR mention', `${validFrontmatter('demo')}Follow the ADR on naming.\n`, 'adr-reference'],
  [
    'an ADR mention in code',
    `${validFrontmatter('demo')}\`\`\`text\nSee adrs.\n\`\`\`\n`,
    'adr-reference',
  ],
  [
    'a See also heading',
    `${validFrontmatter('demo')}## See also\n\n- Nothing.\n`,
    'see-also-heading',
  ],
  ['broken YAML', '---\nname: demo\ndescription: [oops\n---\nBody.\n', 'bad-frontmatter'],
  [
    'a name that differs from the directory',
    `${validFrontmatter('other')}Body.\n`,
    'bad-frontmatter',
  ],
  ['a missing description', '---\nname: demo\n---\nBody.\n', 'bad-frontmatter'],
  [
    'an unknown top-level key',
    '---\nname: demo\ndescription: Does a thing.\nlicense: MIT\n---\n',
    'bad-frontmatter',
  ],
  [
    'an unknown metadata key',
    '---\nname: demo\ndescription: Does a thing.\nmetadata:\n  owner: tau\n---\n',
    'bad-frontmatter',
  ],
  [
    'an empty metadata.required-for',
    '---\nname: demo\ndescription: Does a thing.\nmetadata:\n  required-for: " "\n---\n',
    'bad-frontmatter',
  ],
  [
    'a broken relative link',
    `${validFrontmatter('demo')}Use [the template](template.md#body).\n`,
    'broken-link',
  ],
  [
    'a missing reference link target',
    `${validFrontmatter('demo')}Use [the template][template].\n\n[template]: template.md\n`,
    'broken-link',
  ],
  [
    'a missing angle-bracket link target',
    `${validFrontmatter('demo')}Use [the template](<body template.md>).\n`,
    'broken-link',
  ],
])('reports %s', async (_case, content, kind) => {
  const directory = await createSkills({ demo: content });
  const skillFile = join(directory, 'demo', 'SKILL.md');

  const problems = findSkillProblems(directory);

  expect(new Set(problems.map((problem) => problem.kind))).toEqual(new Set([kind]));
  expect(new Set(problems.map((problem) => problem.file))).toEqual(new Set([skillFile]));
});

it('accepts sibling and reference links, URLs, anchors, code, and words that contain adr', async () => {
  const body = [
    'Commit with the [commit skill](../commit/SKILL.md#procedure).',
    'Read [the spec](https://agentskills.io/specification) and [mail](mailto:team@example.com).',
    'Jump to [the steps](#procedure). Check the address.',
    'Restack with the [stack skill][stack].',
    '',
    '[stack]: ../commit/SKILL.md',
    '',
    '## Procedure',
    '',
    'Write `[inline](missing.md)` as text.',
    '',
    '```markdown',
    '[fenced](missing.md)',
    '```',
    '',
  ].join('\n');

  const directory = await createSkills({
    demo: `---\nname: demo\ndescription: Does a thing.\nmetadata:\n  required-for: pushing a branch\n---\n${body}`,
    commit: `${validFrontmatter('commit')}Body.\n`,
  });

  expect(findSkillProblems(directory)).toEqual([]);
});
