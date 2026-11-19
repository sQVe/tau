import { posix } from 'node:path';

export interface HcIsolationFacts {
  session: string | undefined;
  inheritedSession: string | undefined;
  values: Readonly<Partial<Record<ProtectedVariable, string | undefined>>>;
  realValues: Readonly<Partial<Record<ProtectedVariable, string | undefined>>>;
  variables: readonly string[];
}

type Containment = 'equal' | 'inside' | 'outside';

export const protectedVariables = [
  'HOME',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
] as const;

export type ProtectedVariable = (typeof protectedVariables)[number];

// Resolves . and .. segments in one lexical form. Every path here is absolute.
const normalize = (value: string): string => posix.resolve('/', value);

const containment = (candidate: string, real: string): Containment => {
  const base = normalize(real);
  const resolved = normalize(candidate);

  if (resolved === base) {
    return 'equal';
  }

  return base === '/' || resolved.startsWith(`${base}/`) ? 'inside' : 'outside';
};

// A worker's TMPDIR sits inside the real HOME, so a root there must fall back to /tmp.
export const isolatedRootParent = (
  temporaryDirectory: string,
  realHome: string | undefined,
): string => {
  if (realHome === undefined || realHome === '') {
    return temporaryDirectory;
  }

  return containment(temporaryDirectory, realHome) === 'outside' ? temporaryDirectory : '/tmp';
};

const inheritedProblem = (name: string): boolean => name !== 'HC_SESSION' && name.startsWith('HC_');

// XDG_STATE_HOME defaults under the real home when the runner leaves it unset.
const defaultRealValue = (
  name: ProtectedVariable,
  realValues: Readonly<Partial<Record<ProtectedVariable, string | undefined>>>,
): string | undefined => {
  const home = realValues['HOME'];

  return name === 'XDG_STATE_HOME' && home !== undefined && home !== ''
    ? `${normalize(home)}/.local/state`
    : undefined;
};

const effectiveRealValue = (
  name: ProtectedVariable,
  realValues: Readonly<Partial<Record<ProtectedVariable, string | undefined>>>,
): string | undefined => {
  const real = realValues[name];

  return real === undefined || real === '' ? defaultRealValue(name, realValues) : real;
};

// Checks only the private-path variables that are present, because a process may inherit the rest
// from the core it runs on.
export const privatePathProblems = (
  values: Readonly<Partial<Record<ProtectedVariable, string | undefined>>>,
  realValues: Readonly<Partial<Record<ProtectedVariable, string | undefined>>>,
): string[] => {
  const problems: string[] = [];

  for (const name of protectedVariables) {
    const value = values[name];
    const real = effectiveRealValue(name, realValues);

    if (value === undefined || value === '') {
      continue;
    }

    if (real === undefined || real === '') {
      continue;
    }

    const relation = containment(value, real);

    if (relation === 'equal') {
      problems.push(`${name} equals the real ${name}`);
    } else if (relation === 'inside') {
      problems.push(`${name} is inside the real ${name}`);
    }
  }

  return problems;
};

export const isolationProblems = ({
  session,
  inheritedSession,
  values,
  realValues,
  variables,
}: HcIsolationFacts): string[] => {
  const problems: string[] = [];
  const trimmedSession = (session ?? '').trim();

  if (trimmedSession === '') {
    problems.push('HC_SESSION is missing');
  } else if (trimmedSession === 'default') {
    problems.push('HC_SESSION is the default session');
  } else if (trimmedSession === inheritedSession?.trim()) {
    problems.push('HC_SESSION equals the inherited HC_SESSION');
  }

  for (const name of variables) {
    if (inheritedProblem(name)) {
      problems.push(`${name} must not be set`);
    }
  }

  for (const name of protectedVariables) {
    const value = values[name];

    if (value === undefined || value === '') {
      problems.push(`${name} is missing`);
    }
  }

  problems.push(...privatePathProblems(values, realValues));

  return problems;
};
