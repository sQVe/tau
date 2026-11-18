import { parse } from 'smol-toml';

export interface SyncRecord {
  version: string;
  files: ReadonlyMap<string, string>;
}

type Table = Readonly<Record<string, unknown>>;

const currentKeys = new Set(['schema', 'version', 'agents', 'files']);
const previousKeys = new Set(['version', 'files']);
const previousRoot = 'docs/stomme/';
const managedBlockFile = 'AGENTS.md';
const sha256Hex = /^[\da-f]{64}$/;
const repair = 'fix the record or run stomme sync';

// Every message completes a sentence that starts with the record's path.
const parseTable = (text: string): Table => {
  try {
    return parse(text, { integersAsBigInt: true });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : error;
    const [firstLine = ''] = String(rawMessage).split('\n');

    throw new Error(`is not valid TOML: ${firstLine}; ${repair}`, { cause: error });
  }
};

const requireReadableSchema = (schema: unknown) => {
  if (typeof schema === 'bigint' && schema > 1n) {
    throw new Error(`uses record schema ${schema}; update Tau to read it`);
  }

  if (schema !== 1n) {
    throw new Error(`has an unreadable \`schema\`; Tau reads \`schema = 1\`, so ${repair}`);
  }
};

const requireKnownKeys = (table: Table, known: ReadonlySet<string>) => {
  const unknown = Object.keys(table).find((key) => !known.has(key));

  if (unknown !== undefined) {
    throw new Error(`has the unknown key \`${unknown}\`; remove it or run stomme sync`);
  }
};

const requireTextAgents = (agents: unknown) => {
  if (typeof agents !== 'string') {
    throw new TypeError('has an `agents` value that is not a string; run stomme sync');
  }
};

const readVersion = (version: unknown): string => {
  if (typeof version !== 'string' || version === '') {
    throw new Error('has no `version`; run stomme sync');
  }

  return version;
};

const readFileEntries = (files: unknown): [string, unknown][] => {
  const isObject = typeof files === 'object' && files !== null;

  // A TOML date is an object too.
  if (!isObject || Array.isArray(files) || files instanceof Date) {
    throw new Error('has no `[files]` table; run stomme sync');
  }

  return Object.entries(files);
};

const readHash = (path: string, hash: unknown): string => {
  if (typeof hash !== 'string' || !sha256Hex.test(hash)) {
    throw new Error(
      `has a hash for ${path} that is not 64 lowercase hex characters; run stomme sync`,
    );
  }

  return hash;
};

const requireContainedPath = (path: string) => {
  if (path.startsWith('/')) {
    throw new Error(`has the absolute path ${path}; run stomme sync`);
  }

  if (path.split('/').includes('..')) {
    throw new Error(`has the path ${path}, which holds \`..\`; run stomme sync`);
  }

  if (path.includes('\\')) {
    throw new Error(`has the path ${path}, which holds a backslash; run stomme sync`);
  }
};

// A previous record's keys start at the project root, and it lists the managed AGENTS.md block.
const previousPath = (path: string): string | undefined => {
  if (path === managedBlockFile) {
    return undefined;
  }

  if (!path.startsWith(previousRoot)) {
    throw new Error(`has the path ${path}, which is outside ${previousRoot}; run stomme sync`);
  }

  return path.slice(previousRoot.length);
};

const readFiles = (
  entries: readonly [string, unknown][],
  isPrevious: boolean,
): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();

  for (const [key, value] of entries) {
    const hash = readHash(key, value);

    requireContainedPath(key);

    const path = isPrevious ? previousPath(key) : key;

    if (path !== undefined) {
      files.set(path, hash);
    }
  }

  return files;
};

export const parseSyncRecord = (text: string): SyncRecord => {
  const table = parseTable(text);
  const isPrevious = !('schema' in table);

  if (!isPrevious) {
    requireReadableSchema(table.schema);
  }

  const knownKeys = isPrevious ? previousKeys : currentKeys;

  requireKnownKeys(table, knownKeys);

  if ('agents' in table) {
    requireTextAgents(table.agents);
  }

  const version = readVersion(table.version);
  const files = readFiles(readFileEntries(table.files), isPrevious);

  return { version, files };
};
