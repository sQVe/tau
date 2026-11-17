import type { RoleKind } from '../role.js';
import { isRecord } from '../schema.js';
import type { KnownKeys } from '../schema.js';
import { readUserOnlyKey, warnUnknownKeys } from './config.js';
import type { ConfigLocation, ConfigWarnings } from './config.js';
import { parseModelReference } from './models.js';

interface RoleEntries {
  source: string;
  entries: Record<string, unknown>;
}

interface RoleRecord {
  source: string;
  field: string;
  entry: Record<string, unknown>;
}

export const roleModelKinds = ['lead', 'architect'] as const;

type RoleModelKind = (typeof roleModelKinds)[number];

const knownRoleNames: KnownKeys = { lead: true, architect: true };

const knownRoleKeys: KnownKeys = {
  model: true,
  profiles: true,
};

const knownRoleProfileKeys: KnownKeys = {
  model: true,
};

const invalid = (source: string, message: string): Error =>
  new Error(`Invalid Tau config ${source}: ${message}`);

const parseModel = (source: string, field: string, value: unknown): string => {
  if (typeof value !== 'string' || !parseModelReference(value)) {
    throw invalid(source, `${field} ${JSON.stringify(value)} is not provider/model-id.`);
  }

  return value;
};

const isRoleModelKind = (role: RoleKind): role is RoleModelKind => role !== 'worker';

const readRoleEntries = (location: ConfigLocation, ui: ConfigWarnings): RoleEntries | undefined => {
  const user = readUserOnlyKey(location, 'roles');

  if (user === undefined) {
    return undefined;
  }

  const { source, value } = user;

  if (!isRecord(value)) {
    throw invalid(
      source,
      'roles must be an object that maps role names to {"model": "provider/model-id"}.',
    );
  }

  warnUnknownKeys(ui, source, value, knownRoleNames, 'roles');

  return { source, entries: value };
};

const readRoleRecord = (
  location: ConfigLocation,
  role: RoleKind,
  ui: ConfigWarnings,
): RoleRecord | undefined => {
  if (!isRoleModelKind(role)) {
    return undefined;
  }

  const roles = readRoleEntries(location, ui);

  if (roles === undefined || !Object.hasOwn(roles.entries, role)) {
    return undefined;
  }

  const { source, entries } = roles;
  const field = `roles.${role}`;
  const entry = entries[role];

  if (!isRecord(entry)) {
    throw invalid(source, `${field} must be an object such as {"model": "provider/model-id"}.`);
  }

  warnUnknownKeys(ui, source, entry, knownRoleKeys, field);

  return { source, field, entry };
};

export const readRoleModel = (
  location: ConfigLocation,
  role: RoleKind,
  ui: ConfigWarnings,
): string | undefined => {
  const record = readRoleRecord(location, role, ui);

  if (record === undefined || record.entry.model === undefined) {
    return undefined;
  }

  return parseModel(record.source, `${record.field}.model`, record.entry.model);
};

export const readRoleProfileModel = (
  location: ConfigLocation,
  role: RoleKind,
  profile: string,
  ui: ConfigWarnings,
): string | undefined => {
  const record = readRoleRecord(location, role, ui);

  if (record === undefined || record.entry.profiles === undefined) {
    return undefined;
  }

  const { source, field } = record;
  const profiles = record.entry.profiles;

  if (!isRecord(profiles)) {
    throw invalid(
      source,
      `${field}.profiles must be an object that maps profile names to {"model": "provider/model-id"}.`,
    );
  }

  const profileEntry = profiles[profile];

  if (profileEntry === undefined) {
    return undefined;
  }

  const profileField = `${field}.profiles.${profile}`;

  if (!isRecord(profileEntry)) {
    throw invalid(
      source,
      `${profileField} must be an object such as {"model": "provider/model-id"}.`,
    );
  }

  warnUnknownKeys(ui, source, profileEntry, knownRoleProfileKeys, profileField);

  if (profileEntry.model === undefined) {
    return undefined;
  }

  return parseModel(source, `${profileField}.model`, profileEntry.model);
};
