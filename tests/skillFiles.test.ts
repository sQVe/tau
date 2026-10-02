import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { blockIdentity, findSkillProblems } from './skillFiles.js';
import type { SkillAllowlists, SkillProblemKind } from './skillFiles.js';

const skillsDirectory = join(import.meta.dirname, '..', 'src', 'skills');

// Existing sections and shell blocks that predate the checks. Remove an entry when its skill
// changes; never add one.
const tauAllowlists: SkillAllowlists = {
  extraHeadings: {
    'code-review': ['Review assignment', 'Checker assignment', 'Report'],
    'pr-feedback': ['Replies'],
    'start-slice': ['Changes after the start'],
  },
  multiCommandShellBlocks: {
    'code-review': ['e0e500f34f20', '892f0371f08b'],
    handoff: ['1927769d42b4'],
    pr: ['0e303365f0fe', 'e16c689d6943'],
    slice: ['d4b87a0380fb'],
    'start-slice': ['16e2bc9782a1'],
  },
};

const noAllowlists: SkillAllowlists = { extraHeadings: {}, multiCommandShellBlocks: {} };

const validFrontmatter = (name: string) =>
  `---\nname: ${name}\ndescription: Does a thing. Use when asked.\n---\n`;

const shellBlock = (...lines: string[]) =>
  `${validFrontmatter('demo')}\`\`\`sh\n${lines.join('\n')}\n\`\`\`\n`;

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
  expect(findSkillProblems(skillsDirectory, tauAllowlists)).toEqual([]);
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
    `${validFrontmatter('demo')}### See also\n\n- Nothing.\n`,
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
    'a missing link target with a single-quoted title',
    `${validFrontmatter('demo')}Use [the template](template.md 'Template').\n`,
    'broken-link',
  ],
  [
    'a missing link target with a parenthesized title',
    `${validFrontmatter('demo')}Use [the template](template.md (Template)).\n`,
    'broken-link',
  ],
  [
    'a link target that does not decode',
    `${validFrontmatter('demo')}Reach [full coverage](100%).\n`,
    'broken-link',
  ],
  [
    'a broken link after a longer closing fence',
    `${validFrontmatter('demo')}\`\`\`text\nSample.\n\`\`\`\`\n\nUse [the template](template.md).\n`,
    'broken-link',
  ],
  [
    'an unknown heading after a longer closing fence',
    `${validFrontmatter('demo')}~~~text\nSample.\n~~~~~\n\n## Notes\n`,
    'unknown-heading',
  ],
  [
    'a missing angle-bracket link target',
    `${validFrontmatter('demo')}Use [the template](<body template.md>).\n`,
    'broken-link',
  ],
  ['an unknown section heading', `${validFrontmatter('demo')}## Notes\n`, 'unknown-heading'],
  ['commands joined by &&', shellBlock('git fetch && git status'), 'multi-command-shell-block'],
  ['commands joined by ||', shellBlock('git fetch || true'), 'multi-command-shell-block'],
  ['commands joined by ;', shellBlock('cd docs; ls'), 'multi-command-shell-block'],
  ['commands joined by |', shellBlock('git log | head'), 'multi-command-shell-block'],
  ['commands on two lines', shellBlock('git fetch', 'git status'), 'multi-command-shell-block'],
  [
    'commands continued after &&',
    shellBlock('git fetch &&', '  git status'),
    'multi-command-shell-block',
  ],
  [
    'commands in an untagged block',
    `${validFrontmatter('demo')}\`\`\`\ngit fetch\ngit status\n\`\`\`\n`,
    'multi-command-shell-block',
  ],
  [
    'a command after a comment that ends in a backslash',
    shellBlock('git fetch # fetch first \\', 'git status'),
    'multi-command-shell-block',
  ],
  [
    'commands in a double-quoted substitution',
    shellBlock('printf "%s\\n" "$(git fetch && git status)"'),
    'multi-command-shell-block',
  ],
  [
    'a command in a backtick substitution',
    shellBlock('echo `git rev-parse HEAD`'),
    'multi-command-shell-block',
  ],
  [
    'commands in process substitutions',
    shellBlock('diff <(sort a) <(sort b)'),
    'multi-command-shell-block',
  ],
  [
    'a shell block that does not parse',
    shellBlock('echo "unterminated'),
    'multi-command-shell-block',
  ],
  [
    'a command run in the background',
    shellBlock('git fetch & git status'),
    'multi-command-shell-block',
  ],
  [
    'a command after a heredoc in a list item',
    `${validFrontmatter('demo')}1. Run:\n\n   \`\`\`sh\n   cat <<'EOF'\n   data\n   EOF\n   git status\n   \`\`\`\n`,
    'multi-command-shell-block',
  ],
  [
    'commands in a console block',
    `${validFrontmatter('demo')}\`\`\`console\n$ git fetch\n$ git status\n\`\`\`\n`,
    'multi-command-shell-block',
  ],
])('reports %s', async (_case, content, kind) => {
  const directory = await createSkills({ demo: content });
  const skillFile = join(directory, 'demo', 'SKILL.md');

  const problems = findSkillProblems(directory, noAllowlists);

  expect(new Set(problems.map((problem) => problem.kind))).toEqual(new Set([kind]));
  expect(new Set(problems.map((problem) => problem.file))).toEqual(new Set([skillFile]));
});

it.each<[string, string, SkillAllowlists, SkillProblemKind]>([
  [
    'a heading allowed only for another skill',
    '## Report\n',
    { extraHeadings: { commit: ['Report'] }, multiCommandShellBlocks: {} },
    'unknown-heading',
  ],
  [
    'a stale heading entry',
    '## Procedure\n',
    { extraHeadings: { commit: ['Report'], demo: ['Replies'] }, multiCommandShellBlocks: {} },
    'stale-allowlist',
  ],
  [
    'a stale shell block entry',
    '```sh\ngit status\n```\n',
    {
      extraHeadings: { commit: ['Report'] },
      multiCommandShellBlocks: { demo: ['000000000000'] },
    },
    'stale-allowlist',
  ],
])('reports %s', async (_case, demoBody, allowlists, kind) => {
  const directory = await createSkills({
    demo: `${validFrontmatter('demo')}${demoBody}`,
    commit: `${validFrontmatter('commit')}## Report\n`,
  });

  const skillFile = join(directory, 'demo', 'SKILL.md');

  const problems = findSkillProblems(directory, allowlists);

  expect(problems.map((problem) => ({ file: problem.file, kind: problem.kind }))).toEqual([
    { file: skillFile, kind },
  ]);
});

it('reports a copy of an allowlisted shell block', async () => {
  const block = '```sh\ngit fetch && git status\n```\n';
  const directory = await createSkills({ demo: `${validFrontmatter('demo')}${block}\n${block}` });

  const problems = findSkillProblems(directory, {
    extraHeadings: {},
    multiCommandShellBlocks: { demo: [blockIdentity('git fetch && git status\n')] },
  });

  expect(problems.map(({ file, kind }) => ({ file, kind }))).toEqual([
    { file: join(directory, 'demo', 'SKILL.md'), kind: 'multi-command-shell-block' },
  ]);
});

it('reports an allowlist entry for a skill that does not exist', async () => {
  const directory = await createSkills({ demo: `${validFrontmatter('demo')}Body.\n` });

  const problems = findSkillProblems(directory, {
    extraHeadings: {},
    multiCommandShellBlocks: { gone: ['000000000000'] },
  });

  expect(problems.map(({ file, kind }) => ({ file, kind }))).toEqual([
    { file: join(directory, 'gone', 'SKILL.md'), kind: 'stale-allowlist' },
  ]);
});

it('accepts valid links, code, words that contain adr, and one-command shell blocks', async () => {
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
    '## Not a section',
    '```',
    '',
    '```sh',
    'git push --force-with-lease origin \\',
    '  HEAD',
    '```',
    '',
    '```sh',
    "linear api 'query { issue { children { nodes { id } } } }' --variable 'a=b && c; d | e'",
    '```',
    '',
    '```sh',
    "cat > notes.md <<'EOF'",
    'first; second | third',
    'EOF',
    '```',
    '',
    '```sh',
    'echo foo\\&bar\\;baz',
    '```',
    '',
    '```sh',
    'git status 2>&1 # a | b; c & d',
    '```',
    '',
    '```sh',
    "git log --format='$(not run) `nor this`' -1",
    '```',
    '',
    '```console',
    '$ git status',
    'On branch main; nothing | to commit && done',
    '```',
    '',
    '```text',
    'first line',
    'second line',
    '```',
    '',
  ].join('\n');

  const directory = await createSkills({
    demo: `---\nname: demo\ndescription: Does a thing.\nmetadata:\n  required-for: pushing a branch\n---\n${body}`,
    commit: `${validFrontmatter('commit')}Body.\n`,
  });

  expect(findSkillProblems(directory, noAllowlists)).toEqual([]);
});
