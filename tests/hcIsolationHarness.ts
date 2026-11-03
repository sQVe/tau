export interface HcIsolationFacts {
  session: string | undefined;
  inheritedSession: string | undefined;
  values: Readonly<Partial<Record<ProtectedVariable, string | undefined>>>;
  realValues: Readonly<Partial<Record<ProtectedVariable, string | undefined>>>;
  variables: readonly string[];
}

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
const normalize = (value: string): string => {
  const segments: string[] = [];

  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }

    if (segment === '..') {
      segments.pop();

      continue;
    }

    segments.push(segment);
  }

  return `/${segments.join('/')}`;
};

const isInside = (candidate: string, real: string): boolean => {
  const base = normalize(real);
  const prefix = base === '/' ? '/' : `${base}/`;

  return normalize(candidate).startsWith(prefix);
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

    if (normalize(value) === normalize(real)) {
      problems.push(`${name} equals the real ${name}`);
    } else if (isInside(value, real)) {
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
