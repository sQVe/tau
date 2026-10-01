import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadSkillsFromDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';

import { requiredActions } from '../src/extensions/tauSkills/requiredFor.js';

export type SkillProblemKind =
  | 'adr-reference'
  | 'see-also-heading'
  | 'bad-frontmatter'
  | 'broken-link';

export interface SkillProblem {
  file: string;
  kind: SkillProblemKind;
  detail: string;
}

const topLevelKeys = new Set(['name', 'description', 'metadata']);
const metadataKeys = new Set(['required-for']);

const fencedCodeBlock = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;
const inlineCode = /(`+)[\s\S]*?\1/g;
const inlineLink = /\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)]*))(?:\s+"[^"]*")?\s*\)/g;
const referenceDefinition = /^ {0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;
const adrWord = /\bADRs?\b/i;
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

const skillProblems = (skillsDirectory: string, name: string): SkillProblem[] => {
  const file = join(skillsDirectory, name, 'SKILL.md');
  const markdown = readFileSync(file, 'utf8');

  const problemsOf = (kind: SkillProblemKind, details: string[]) =>
    details.map((detail) => ({ file, kind, detail }));

  // Covers the whole file, code included, and every link into `docs/adr/`.
  const adrMentions = adrWord.test(markdown) ? ['mentions an ADR'] : [];
  const headings = seeAlsoHeading.test(withoutCode(markdown)) ? ['has a See also heading'] : [];

  return [
    ...problemsOf('adr-reference', adrMentions),
    ...problemsOf('see-also-heading', headings),
    ...problemsOf('bad-frontmatter', frontmatterProblems(name, file, markdown)),
    ...problemsOf('broken-link', brokenLinks(file, markdown)),
  ];
};

const loadDiagnostics = (skillsDirectory: string): SkillProblem[] =>
  loadSkillsFromDir({ dir: skillsDirectory, source: 'tau' }).diagnostics.map((diagnostic) => ({
    file: diagnostic.path ?? skillsDirectory,
    kind: 'bad-frontmatter',
    detail: diagnostic.message,
  }));

export const findSkillProblems = (skillsDirectory: string): SkillProblem[] => {
  const names = readdirSync(skillsDirectory).filter((name) =>
    existsSync(join(skillsDirectory, name, 'SKILL.md')),
  );

  return [
    ...names.flatMap((name) => skillProblems(skillsDirectory, name)),
    ...loadDiagnostics(skillsDirectory),
  ];
};
