import type { GuideLanguage } from '../stommeGuides/stommeGuidesDecision.js';

type UnreadableActivation = { kind: 'newer'; version: number } | { kind: 'malformed' };

type LanguageToolDecision =
  | { kind: 'ignore' }
  | { kind: 'activate' | 'block'; language: GuideLanguage };

export type CommandMode =
  | { kind: 'bundle' }
  | { kind: 'broken' }
  | { kind: 'project'; declared: GuideLanguage };

export type CommandOutcome =
  | { kind: 'activate' }
  | {
      kind: 'notice';
      reason: 'broken' | 'no-coding-set' | 'other-language' | 'loaded';
      level: 'info' | 'warning';
    };

export const languageRulesTypes: Readonly<Record<GuideLanguage, string>> = {
  typescript: 'tau-typescript-rules',
  rust: 'tau-rust-rules',
};

const languageByExtension: ReadonlyMap<string, GuideLanguage> = new Map([
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['rs', 'rust'],
]);

const ignoredFolder: Readonly<Record<GuideLanguage, string>> = {
  typescript: 'node_modules',
  rust: 'target',
};

export const languageForPath = (path: unknown): GuideLanguage | undefined => {
  if (typeof path !== 'string') {
    return undefined;
  }

  const extension = /\.([^./\\]+)$/u.exec(path)?.[1] ?? '';
  const language = languageByExtension.get(extension);

  if (language === undefined) {
    return undefined;
  }

  if (path.split(/[\\/]/u).includes(ignoredFolder[language])) {
    return undefined;
  }

  if (language === 'typescript' && /\.d\.(?:ts|mts|cts)$/u.test(path)) {
    return undefined;
  }

  return language;
};

export const languageToolDecision = (
  tool: string,
  path: unknown,
  loaded: ReadonlySet<GuideLanguage>,
): LanguageToolDecision => {
  if (!['read', 'edit', 'write'].includes(tool)) {
    return { kind: 'ignore' };
  }

  const language = languageForPath(path);

  if (language === undefined) {
    return { kind: 'ignore' };
  }

  if (tool !== 'read' && !loaded.has(language)) {
    return { kind: 'block', language };
  }

  return { kind: 'activate', language };
};

const classifyActivationData = (data: unknown): { kind: 'current' } | UnreadableActivation => {
  if (typeof data !== 'object' || data === null) {
    return { kind: 'malformed' };
  }

  if (!('version' in data) || typeof data.version !== 'number') {
    return { kind: 'malformed' };
  }

  if (!Number.isInteger(data.version)) {
    return { kind: 'malformed' };
  }

  if (data.version > 1) {
    return { kind: 'newer', version: data.version };
  }

  if (data.version !== 1 || Object.keys(data).length !== 1) {
    return { kind: 'malformed' };
  }

  return { kind: 'current' };
};

export const classifyLanguageActivation = (
  entries: readonly unknown[],
  language: GuideLanguage,
): { active: boolean; unreadable: UnreadableActivation[] } => {
  let active = false;
  const unreadable: UnreadableActivation[] = [];

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    if (!('type' in entry) || entry.type !== 'custom') {
      continue;
    }

    if (!('customType' in entry) || entry.customType !== languageRulesTypes[language]) {
      continue;
    }

    const data = 'data' in entry ? entry.data : undefined;
    const classification = classifyActivationData(data);

    if (classification.kind === 'current') {
      active = true;
    } else {
      unreadable.push(classification);
    }
  }

  return { active, unreadable };
};

export const commandOutcome = (
  mode: CommandMode,
  requested: GuideLanguage,
  usesCodingSet: boolean,
): CommandOutcome => {
  if (mode.kind === 'bundle') {
    return { kind: 'activate' };
  }

  if (mode.kind === 'broken') {
    return { kind: 'notice', reason: 'broken', level: 'warning' };
  }

  if (!usesCodingSet) {
    return { kind: 'notice', reason: 'no-coding-set', level: 'warning' };
  }

  if (mode.declared !== requested) {
    return { kind: 'notice', reason: 'other-language', level: 'warning' };
  }

  return { kind: 'notice', reason: 'loaded', level: 'info' };
};
