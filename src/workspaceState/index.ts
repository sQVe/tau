import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import * as lockfile from 'proper-lockfile';

import { workspaceStateEnvelopeSchema, workspaceStateVersion } from './types.js';
import type { WorkspaceNamespace, WorkspaceState, WorkspaceStateEnvelope } from './types.js';

export { workspaceStateEnvelopeSchema, workspaceStateVersion } from './types.js';
export type { WorkspaceNamespace, WorkspaceState, WorkspaceStateEnvelope } from './types.js';

interface WorkspaceStateDependencies {
  mkdir: typeof mkdir;
  open: typeof open;
  readFile: typeof readFile;
  readdir: typeof readdir;
  rename: typeof rename;
  rm: typeof rm;
  lock: typeof lockfile.lock;
}

type JsonObject = Record<string, unknown>;

const defaultDependencies: WorkspaceStateDependencies = {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  lock: lockfile.lock,
};

export class WorkspaceStateVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceStateVersionError';
  }
}

export class WorkspaceStateShapeError extends WorkspaceStateVersionError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceStateShapeError';
  }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error;

const isMissingFileError = (error: unknown): error is NodeJS.ErrnoException =>
  isNodeError(error) && error.code === 'ENOENT';

// Rejects arrays, class instances, null-prototype objects, and cross-realm objects.
// Namespace payloads must survive JSON round-trips, so only literal `{}` shapes are accepted.
const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const cloneJsonValue = <T>(value: T): T => structuredClone(value);

const buildVersionError = (received: string) =>
  new WorkspaceStateVersionError(
    `Unsupported workspace state version: expected ${workspaceStateVersion}, received ${received}`,
  );

const buildShapeError = (detail: string) =>
  new WorkspaceStateShapeError(`Invalid workspace state shape: ${detail}`);

const normalizeEnvelope = (raw: unknown): WorkspaceStateEnvelope => {
  if (!isPlainObject(raw)) {
    throw buildShapeError('root is not a plain object');
  }

  if (raw.version !== workspaceStateVersion) {
    const received = raw.version === undefined ? 'missing version' : JSON.stringify(raw.version);
    throw buildVersionError(received);
  }

  if (!isPlainObject(raw.namespaces)) {
    throw buildShapeError('missing or invalid namespaces');
  }

  const namespaceEntries: [string, JsonObject][] = [];
  for (const [name, value] of Object.entries(raw.namespaces)) {
    if (!isPlainObject(value)) {
      throw buildShapeError(`namespace ${JSON.stringify(name)} is not a plain object`);
    }

    namespaceEntries.push([name, cloneJsonValue(value)]);
  }

  return {
    version: workspaceStateVersion,
    namespaces: Object.fromEntries(namespaceEntries),
  };
};

const createEmptyEnvelope = (): WorkspaceStateEnvelope => ({
  version: workspaceStateVersion,
  namespaces: {},
});

const statePaths = (rootDir: string) => {
  const stateDir = join(rootDir, '.tau');
  const statePath = join(stateDir, 'state.json');
  const lockPath = join(stateDir, 'state.lock');
  const backupPath = join(stateDir, 'state.json.bak');

  return { backupPath, lockPath, stateDir, statePath };
};

const quarantineCorruptState = async (
  deps: WorkspaceStateDependencies,
  statePath: string,
  backupPath: string,
): Promise<void> => {
  try {
    await deps.rm(backupPath, { force: true });
  } catch {
    // Ignore cleanup failures; the rename below is what matters.
  }

  try {
    await deps.rename(statePath, backupPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
};

const readEnvelopeFromDisk = async (
  deps: WorkspaceStateDependencies,
  statePath: string,
  backupPath: string,
): Promise<WorkspaceStateEnvelope> => {
  try {
    const raw = await deps.readFile(statePath, 'utf8');

    try {
      return normalizeEnvelope(JSON.parse(raw));
    } catch (error) {
      await quarantineCorruptState(deps, statePath, backupPath);

      if (error instanceof WorkspaceStateVersionError) {
        throw error;
      }

      return createEmptyEnvelope();
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return createEmptyEnvelope();
    }

    throw error;
  }
};

const syncDirectory = async (
  deps: WorkspaceStateDependencies,
  directory: string,
): Promise<void> => {
  if (process.platform === 'win32') {
    return;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await deps.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is a durability improvement, not a correctness requirement on all platforms.
  } finally {
    await handle?.close();
  }
};

const removeStaleTemporaryFiles = async (
  deps: WorkspaceStateDependencies,
  stateDir: string,
): Promise<void> => {
  let entries: string[];
  try {
    entries = await deps.readdir(stateDir);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('state.json.tmp.'))
      .map(async (entry) => {
        await deps.rm(join(stateDir, entry), { force: true });
      }),
  );
};

const writeEnvelope = async (
  deps: WorkspaceStateDependencies,
  stateDir: string,
  statePath: string,
  envelope: WorkspaceStateEnvelope,
): Promise<void> => {
  await deps.mkdir(stateDir, { recursive: true });

  const tempPath = join(stateDir, `state.json.tmp.${process.pid}.${randomUUID()}`);
  const handle = await deps.open(tempPath, 'w');

  try {
    await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  await deps.rename(tempPath, statePath);
  await syncDirectory(deps, stateDir);
};

export const createWorkspaceState = (
  rootDir = process.cwd(),
  overrides: Partial<WorkspaceStateDependencies> = {},
): WorkspaceState => {
  const deps: WorkspaceStateDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  const { backupPath, lockPath, stateDir, statePath } = statePaths(rootDir);

  // Sweep leaked tmp files once per instance; subsequent writes only leak their own tmp file on crash.
  let staleSwept = false;
  const sweepStaleOnce = async (): Promise<void> => {
    if (staleSwept) {
      return;
    }
    staleSwept = true;
    await removeStaleTemporaryFiles(deps, stateDir);
  };

  const withWriteLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    await deps.mkdir(stateDir, { recursive: true });
    await sweepStaleOnce();

    const release = await deps.lock(statePath, {
      lockfilePath: lockPath,
      realpath: false,
      stale: 10_000,
      update: 5_000,
      retries: { retries: 100, factor: 2, minTimeout: 5, maxTimeout: 100 },
    });

    try {
      return await operation();
    } finally {
      await release();
    }
  };

  const getNamespaceValue = async (name: string): Promise<JsonObject> => {
    const envelope = await readEnvelopeFromDisk(deps, statePath, backupPath);
    const value = envelope.namespaces[name];

    return value === undefined ? {} : cloneJsonValue(value);
  };

  const setNamespaceValue = async (name: string, value: JsonObject): Promise<void> => {
    if (!isPlainObject(value)) {
      throw new TypeError('Workspace state values must be plain objects');
    }

    await withWriteLock(async () => {
      const envelope = await readEnvelopeFromDisk(deps, statePath, backupPath);
      envelope.namespaces[name] = cloneJsonValue(value);
      await writeEnvelope(deps, stateDir, statePath, envelope);
    });
  };

  const patchNamespaceValue = async (
    name: string,
    partialOrUpdater: JsonObject | ((current: JsonObject) => JsonObject),
  ): Promise<void> => {
    await withWriteLock(async () => {
      const envelope = await readEnvelopeFromDisk(deps, statePath, backupPath);
      const storedValue = envelope.namespaces[name];
      const current = storedValue === undefined ? {} : cloneJsonValue(storedValue);
      const partial =
        typeof partialOrUpdater === 'function' ? partialOrUpdater(current) : partialOrUpdater;

      if (!isPlainObject(partial)) {
        throw new TypeError('Workspace state patches must be plain objects');
      }

      envelope.namespaces[name] = {
        ...current,
        ...cloneJsonValue(partial),
      };

      await writeEnvelope(deps, stateDir, statePath, envelope);
    });
  };

  return {
    namespace<T extends JsonObject = JsonObject>(name: string): WorkspaceNamespace<T> {
      const namespaceApi: WorkspaceNamespace = {
        get: () => getNamespaceValue(name),
        set: (value) => setNamespaceValue(name, value),
        patch: (partialOrUpdater) => patchNamespaceValue(name, partialOrUpdater),
      };

      // The runtime contract is concrete; the generic parameter is caller-facing type information.
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      return namespaceApi as WorkspaceNamespace<T>;
    },
  };
};
