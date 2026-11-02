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

const normalize = (value: string): string => {
  const trimmed = value.replace(/\/+$/, '');

  return trimmed === '' ? '/' : trimmed;
};

const isInside = (candidate: string, real: string): boolean => {
  const base = normalize(real);
  const prefix = base === '/' ? '/' : `${base}/`;

  return normalize(candidate).startsWith(prefix);
};

const hasPrivatePrefix = (name: string): boolean =>
  name.startsWith('HC_') || name.startsWith('HERDR_');

const inheritedProblem = (name: string): boolean => name !== 'HC_SESSION' && hasPrivatePrefix(name);

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
    const real = realValues[name];

    if (value === undefined || value === '') {
      problems.push(`${name} is missing`);

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
