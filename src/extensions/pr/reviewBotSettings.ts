import { warnUnknownKeys } from '../../config/config.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { readRepositorySection } from '../../config/repositorySection.js';
import { isRecord } from '../../schema.js';
import type { KnownKeys } from '../../schema.js';
import { normalizeLogin } from './reviewBotDecisions.js';

export interface ReviewBot {
  // The bot's GitHub login, used to find its reviews.
  login: string;
  // The exact body of the comment that requests a review.
  comment: string;
}

const readText = (source: string, field: string, value: unknown): string => {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid Tau config ${source}: ${field} must be a string.`);
  }

  if (!value.trim()) {
    throw new Error(`Invalid Tau config ${source}: ${field} is empty.`);
  }

  return value;
};

const knownBotKeys: KnownKeys = { login: true, comment: true };

const readBot = (source: string, ui: ConfigWarnings, field: string, value: unknown): ReviewBot => {
  warnUnknownKeys(ui, source, value, knownBotKeys, field);

  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be an object such as {"login": "chatgpt-codex-connector", "comment": "@codex review"}.`,
    );
  }

  return {
    login: readText(source, `${field}.login`, value.login),
    comment: readText(source, `${field}.comment`, value.comment),
  };
};

const rejectDuplicateLogins = (source: string, field: string, bots: ReviewBot[]): void => {
  const seen = new Set<string>();

  for (const { login } of bots) {
    const key = normalizeLogin(login);

    // GitHub logins ignore case, and gh omits `[bot]`, so these spellings name one account.
    if (seen.has(key)) {
      throw new Error(`Invalid Tau config ${source}: ${field} lists ${login} twice. Keep one.`);
    }

    seen.add(key);
  }
};

const readEntry = (
  source: string,
  ui: ConfigWarnings,
  field: string,
  value: unknown,
): ReviewBot[] => {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be an object such as {"bots": [{"login": "chatgpt-codex-connector", "comment": "@codex review"}]}.`,
    );
  }

  if (!Array.isArray(value.bots)) {
    throw new TypeError(`Invalid Tau config ${source}: ${field}.bots must be a list of bots.`);
  }

  const bots = value.bots.map((bot, index) => readBot(source, ui, `${field}.bots[${index}]`, bot));

  rejectDuplicateLogins(source, `${field}.bots`, bots);

  return bots;
};

// Reads the review bots of the entry for `repository`. A bad entry for another repository is
// ignored. Resolves undefined when the repository has no entry. Only the user file may set
// `reviews`, since its comments are posted for the user on every pull request of the repository.
export const readReviewBots = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  repository: string,
): ReviewBot[] | undefined =>
  readRepositorySection(location, ui, {
    key: 'reviews',
    knownEntryKeys: { bots: true },
    example: '{"repositories": {"sQVe/tau": {"bots": []}}}',
    repository,
    readEntry: (source, field, value) => readEntry(source, ui, field, value),
  })?.entry;
