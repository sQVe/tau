type UnreadableActivation = { kind: 'newer'; version: number } | { kind: 'malformed' };

export const typeScriptRulesType = 'tau-typescript-rules';

const languageByExtension: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
};

const isTypeScriptPath = (path: unknown): boolean => {
  if (typeof path !== 'string') {
    return false;
  }

  if (path.split(/[\\/]/u).includes('node_modules')) {
    return false;
  }

  if (/\.d\.(?:ts|mts|cts)$/u.test(path)) {
    return false;
  }

  const extension = /\.([^./\\]+)$/u.exec(path)?.[1] ?? '';

  return languageByExtension[extension] === 'typescript';
};

export const typeScriptToolDecision = (
  tool: string,
  path: unknown,
  loaded: boolean,
): 'ignore' | 'activate' | 'block' => {
  if (!['read', 'edit', 'write'].includes(tool)) {
    return 'ignore';
  }

  if (!isTypeScriptPath(path)) {
    return 'ignore';
  }

  if (tool !== 'read' && !loaded) {
    return 'block';
  }

  return 'activate';
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

export const classifyTypeScriptActivation = (
  entries: readonly unknown[],
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

    if (!('customType' in entry) || entry.customType !== typeScriptRulesType) {
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
