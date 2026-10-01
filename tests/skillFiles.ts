import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadSkillsFromDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';

import { requiredActions } from '../src/extensions/tauSkills/requiredFor.js';

export type SkillProblemKind =
  | 'adr-reference'
  | 'see-also-heading'
  | 'bad-frontmatter'
  | 'broken-link'
  | 'unknown-heading'
  | 'multi-command-shell-block'
  | 'stale-allowlist';

export interface SkillProblem {
  file: string;
  kind: SkillProblemKind;
  detail: string;
}

// Each list is keyed by skill name and may only shrink.
export interface SkillAllowlists {
  extraHeadings: Readonly<Record<string, readonly string[]>>;
  multiCommandShellBlocks: Readonly<Record<string, readonly string[]>>;
}

const sectionHeadings = new Set(['When to use', 'Goal', 'Hard rules', 'Procedure', 'Checklist']);
const shellLanguages = new Set(['sh', 'bash', 'shell', 'zsh', '']);
const consolePrompt = '$ ';
const topLevelKeys = new Set(['name', 'description', 'metadata']);
const metadataKeys = new Set(['required-for']);

// Fences in list items are indented, so any indentation opens a block.
const fencedCodeBlock = /^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
const inlineCode = /(`+)[\s\S]*?\1/g;

const inlineLink =
  /\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)]*))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

const referenceDefinition = /^ {0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;
const adrWord = /\bADRs?\b/i;
const sectionHeading = /^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const quotedTextOrComment = /('[^']*'|"(?:[^"\\]|\\.)*")|(^|[ \t])#.*$/gm;
const commandSubstitution = /\$\(|`[^`]*`/g;
const backslashContinuation = /\\[ \t]*\n/g;
const operatorContinuation = /(&&|\|\|?|\{)[ \t]*\n/g;
// A lone `&` runs a command in the background; `>&` and `&>` are redirects.
const commandSeparator = /&&|\|\||;|\||(?<![>&])&(?![>&])/;
const seeAlsoHeading = /^ {0,3}#{1,6}[ \t]+see also[ \t]*#*[ \t]*$/im;
const externalTarget = /^(?:https?|mailto):/i;

const withoutCode = (markdown: string) =>
  markdown.replaceAll(fencedCodeBlock, '').replaceAll(inlineCode, '');

const linkTargets = (markdown: string) =>
  [...markdown.matchAll(inlineLink), ...markdown.matchAll(referenceDefinition)].map(
    (match) => match[1] ?? match[2] ?? '',
  );

const isLocalTarget = (target: string) => !externalTarget.test(target) && !target.startsWith('#');

const resolveTarget = (file: string, target: string) => {
  const [path = ''] = target.split('#');

  return resolve(dirname(file), decodeURIComponent(path));
};

const brokenLinks = (file: string, markdown: string) =>
  linkTargets(withoutCode(markdown))
    .filter(isLocalTarget)
    .filter((target) => !existsSync(resolveTarget(file, target)))
    .map((target) => `links to missing ${target}`);

const sectionHeadingsOf = (markdown: string) =>
  [...withoutCode(markdown).matchAll(sectionHeading)].map((match) => match[1] ?? '');

const unknownHeadings = (headings: readonly string[], extraHeadings: readonly string[]) =>
  headings
    .filter((heading) => !sectionHeadings.has(heading) && !extraHeadings.includes(heading))
    .map((heading) => `unknown section ## ${heading}`);

// Quoted text may hold separators and braces, and a comment may end in `\`, so both are dropped
// before lines are joined.
const withoutQuotesOrComments = (shell: string) =>
  shell.replaceAll(quotedTextOrComment, (_match, quoted?: string, before?: string) =>
    quoted === undefined ? (before ?? '') : "''",
  );

// Single-quoted text stays literal, but `$(...)` and backticks run inside double quotes.
const substitutionCount = (shell: string) => {
  const expandable = shell.replaceAll(
    quotedTextOrComment,
    (match, quoted?: string, before?: string) => {
      if (quoted === undefined) {
        return before ?? '';
      }

      return quoted.startsWith("'") ? "''" : match;
    },
  );

  return [...expandable.matchAll(commandSubstitution)].length;
};

const lineCommandCount = (shell: string) =>
  withoutQuotesOrComments(shell)
    .replaceAll(backslashContinuation, ' ')
    .replaceAll(operatorContinuation, '$1 ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .flatMap((line) => line.split(commandSeparator))
    .filter((command) => command.trim() !== '').length;

const commandCount = (shell: string) => lineCommandCount(shell) + substitutionCount(shell);

// A `console` block holds a session, so only its `$ ` prompt lines are commands.
const shellOf = (language: string, body: string): string | undefined => {
  if (language === 'console') {
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(consolePrompt))
      .map((line) => line.slice(consolePrompt.length))
      .join('\n');
  }

  return shellLanguages.has(language) ? body : undefined;
};

const isMultiCommandShellBlock = (match: RegExpMatchArray) => {
  const language = (match[2] ?? '').trim().split(/\s+/)[0] ?? '';
  const shell = shellOf(language, match[3] ?? '');

  return shell !== undefined && commandCount(shell) > 1;
};

// Trimming each line keeps a block's identity when its list indentation changes.
export const blockIdentity = (body: string) => {
  const lines = body.split('\n').map((line) => line.trim());

  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
};

const multiCommandShellBlocks = (markdown: string) =>
  [...markdown.matchAll(fencedCodeBlock)]
    .filter(isMultiCommandShellBlock)
    .map((match) => blockIdentity(match[3] ?? ''));

// Each allowlist entry covers one block, so a copy of a listed block is reported.
const matchAllowedBlocks = (blocks: readonly string[], allowed: readonly string[]) => {
  const unused = [...allowed];

  const extra = blocks.filter((block) => {
    const index = unused.indexOf(block);

    if (index === -1) {
      return true;
    }

    unused.splice(index, 1);

    return false;
  });

  return { extra, unused };
};

const staleEntries = (allowed: readonly string[], found: readonly string[]) =>
  allowed.filter((entry) => !found.includes(entry)).map((entry) => `allowlists missing ${entry}`);

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parsedFrontmatter = (markdown: string): Record<string, unknown> | string => {
  try {
    return parseFrontmatter(markdown).frontmatter;
  } catch (error) {
    return `frontmatter does not parse: ${String(error)}`;
  }
};

const requiredForProblem = (
  name: string,
  file: string,
  frontmatter: Record<string, unknown>,
): string[] => {
  try {
    requiredActions([{ name, filePath: file, frontmatter }]);

    return [];
  } catch (error) {
    return [String(error)];
  }
};

const frontmatterProblems = (name: string, file: string, markdown: string): string[] => {
  const frontmatter = parsedFrontmatter(markdown);

  if (!isMap(frontmatter)) {
    return [frontmatter];
  }

  const details: string[] = [];

  if (frontmatter['name'] !== name) {
    details.push(`name must be ${name}`);
  }

  const { description } = frontmatter;

  if (typeof description !== 'string' || description.trim() === '') {
    details.push('description must not be empty');
  }

  const unknownKeys = Object.keys(frontmatter).filter((key) => !topLevelKeys.has(key));

  for (const key of unknownKeys) {
    details.push(`unknown top-level key ${key}`);
  }

  const { metadata } = frontmatter;

  const unknownMetadataKeys = isMap(metadata)
    ? Object.keys(metadata).filter((key) => !metadataKeys.has(key))
    : [];

  for (const key of unknownMetadataKeys) {
    details.push(`unknown metadata key ${key}`);
  }

  return [...details, ...requiredForProblem(name, file, frontmatter)];
};

const skillProblems = (
  skillsDirectory: string,
  name: string,
  allowlists: SkillAllowlists,
): SkillProblem[] => {
  const file = join(skillsDirectory, name, 'SKILL.md');
  const markdown = readFileSync(file, 'utf8');
  const extraHeadings = allowlists.extraHeadings[name] ?? [];
  const allowedBlocks = allowlists.multiCommandShellBlocks[name] ?? [];
  const headings = sectionHeadingsOf(markdown);
  const blocks = multiCommandShellBlocks(markdown);

  const { extra, unused } = matchAllowedBlocks(blocks, allowedBlocks);

  const problemsOf = (kind: SkillProblemKind, details: string[]) =>
    details.map((detail) => ({ file, kind, detail }));

  // Covers the whole file, code included, and every link into `docs/adr/`.
  const adrMentions = adrWord.test(markdown) ? ['mentions an ADR'] : [];
  const seeAlso = seeAlsoHeading.test(withoutCode(markdown)) ? ['has a See also heading'] : [];

  return [
    ...problemsOf('adr-reference', adrMentions),
    ...problemsOf('see-also-heading', seeAlso),
    ...problemsOf('bad-frontmatter', frontmatterProblems(name, file, markdown)),
    ...problemsOf('broken-link', brokenLinks(file, markdown)),
    ...problemsOf('unknown-heading', unknownHeadings(headings, extraHeadings)),
    ...problemsOf(
      'multi-command-shell-block',
      extra.map((block) => `shell block ${block} holds more than one command`),
    ),
    ...problemsOf('stale-allowlist', staleEntries(extraHeadings, headings)),
    ...problemsOf(
      'stale-allowlist',
      unused.map((entry) => `allowlists missing ${entry}`),
    ),
  ];
};

const loadDiagnostics = (skillsDirectory: string): SkillProblem[] =>
  loadSkillsFromDir({ dir: skillsDirectory, source: 'tau' }).diagnostics.map((diagnostic) => ({
    file: diagnostic.path ?? skillsDirectory,
    kind: 'bad-frontmatter',
    detail: diagnostic.message,
  }));

const missingSkillEntries = (
  skillsDirectory: string,
  names: readonly string[],
  allowlists: SkillAllowlists,
): SkillProblem[] => {
  const listed = [
    ...Object.keys(allowlists.extraHeadings),
    ...Object.keys(allowlists.multiCommandShellBlocks),
  ];

  return [...new Set(listed)]
    .filter((name) => !names.includes(name))
    .map((name) => ({
      file: join(skillsDirectory, name, 'SKILL.md'),
      kind: 'stale-allowlist',
      detail: `allowlists missing skill ${name}`,
    }));
};

export const findSkillProblems = (
  skillsDirectory: string,
  allowlists: SkillAllowlists,
): SkillProblem[] => {
  const names = readdirSync(skillsDirectory).filter((name) =>
    existsSync(join(skillsDirectory, name, 'SKILL.md')),
  );

  return [
    ...names.flatMap((name) => skillProblems(skillsDirectory, name, allowlists)),
    ...missingSkillEntries(skillsDirectory, names, allowlists),
    ...loadDiagnostics(skillsDirectory),
  ];
};
