import { anyKey, isRecord } from '../schema.js';
import type { KnownKeys } from '../schema.js';
import type { ConfigLocation, ConfigWarnings } from './config.js';
import { warnUnknownKeys } from './config.js';
import { findRepositoryFile, readArgv, sectionOf } from './repositoryCommand.js';

export interface VerificationTarget {
  launch: string[];
  doctor: string[];
  stop: string[];
}

export type VerificationTargetRead =
  | { kind: 'configured'; target: VerificationTarget }
  | { kind: 'notConfigured'; ignored: string | undefined }
  | { kind: 'unknown'; names: string[] };

const example =
  '{"launch": ["pnpm", "app:up"], "doctor": ["pnpm", "app:doctor"], "stop": ["pnpm", "app:down"]}';

const commandExamples = {
  launch: '["pnpm", "app:up"]',
  doctor: '["pnpm", "app:doctor"]',
  stop: '["pnpm", "app:down"]',
};

const targetKeys = { [anyKey]: { launch: true, doctor: true, stop: true } } satisfies KnownKeys;

const targetNamePattern = /^[a-z0-9][a-z0-9-]*$/u;

const requireSection = (source: string, value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: verification must be an object such as {"targets": {"app": ${example}}}.`,
    );
  }

  return value;
};

const requireTargets = (source: string, value: unknown): Record<string, unknown> => {
  if (value === undefined) {
    throw new Error(
      `Invalid Tau config ${source}: verification.targets is missing. Add at least one target, such as {"app": ${example}}.`,
    );
  }

  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: verification.targets must be an object keyed by target name, such as {"app": ${example}}.`,
    );
  }

  if (Object.keys(value).length === 0) {
    throw new Error(
      `Invalid Tau config ${source}: verification.targets must name at least one target, such as {"app": ${example}}.`,
    );
  }

  return value;
};

const requireTargetName = (source: string, name: string): void => {
  if (!targetNamePattern.test(name)) {
    throw new Error(
      `Invalid Tau config ${source}: ${JSON.stringify(name)} in verification.targets must use lower-case letters, digits, and hyphens, such as "sandbox".`,
    );
  }
};

const requireTarget = (source: string, name: string, value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: verification.targets.${name} must be an object such as ${example}.`,
    );
  }

  return value;
};

const requireCommand = (
  source: string,
  name: string,
  command: keyof typeof commandExamples,
  value: unknown,
): string[] => {
  if (value === undefined) {
    throw new Error(
      `Invalid Tau config ${source}: verification.targets.${name}.${command} is missing. Give it an argv such as ${commandExamples[command]}.`,
    );
  }

  return readArgv(source, `verification.targets.${name}.${command}`, value);
};

const readTarget = (source: string, name: string, value: unknown): VerificationTarget => {
  const target = requireTarget(source, name, value);

  return {
    launch: requireCommand(source, name, 'launch', target.launch),
    doctor: requireCommand(source, name, 'doctor', target.doctor),
    stop: requireCommand(source, name, 'stop', target.stop),
  };
};

export const readVerificationTarget = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  name: string,
): VerificationTargetRead => {
  const { project, ignored } = findRepositoryFile(location, 'verification');

  if (project === undefined) {
    return { kind: 'notConfigured', ignored };
  }

  const section = requireSection(project.source, sectionOf(project, 'verification'));

  warnUnknownKeys(ui, project.source, section, { targets: targetKeys }, 'verification');

  const targets = requireTargets(project.source, section.targets);
  const names = Object.keys(targets).toSorted();

  if (!Object.hasOwn(targets, name)) {
    return { kind: 'unknown', names };
  }

  requireTargetName(project.source, name);

  return { kind: 'configured', target: readTarget(project.source, name, targets[name]) };
};
