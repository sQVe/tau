import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface InputFile {
  name: string;
  path: string;
}

export interface TauArtifactInputs {
  key: string;
  // Every file the key covers, so the build can check what Rolldown reads against it.
  inputPaths: readonly string[];
}

// The bundle can only take modules with these suffixes, so only they can change its code.
const keyedInputSuffixes: ReadonlySet<string> = new Set(['.ts', '.mts', '.js', '.mjs', '.json']);

const fixedInputs = ['package.json', 'tsconfig.json', 'scripts/buildTauExtension.ts'];

const artifactKeyPattern = /^[0-9a-f]{64}$/u;

const uniqueInputs = (inputs: readonly InputFile[]): InputFile[] => {
  const byName = new Map<string, InputFile>();

  for (const input of inputs) {
    byName.set(input.name, input);
  }

  return [...byName.values()];
};

const compareNames = (first: InputFile, second: InputFile): number => {
  if (first.name === second.name) {
    return 0;
  }

  return first.name < second.name ? -1 : 1;
};

// A directory with its own manifest is a separate package, so its files are not this package's
// build inputs.
const holdsOwnManifest = (entries: { name: string }[]): boolean =>
  entries.some((entry) => entry.name === 'package.json');

// A symlink can point outside the package or into a nested package, so no key can cover its bytes.
const assertNoSymbolicLinks = async (packageRoot: string, directory: string): Promise<void> => {
  const entries = await readdir(join(packageRoot, directory), { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Tau artifact input ${directory}/${entry.name} is a symbolic link.`);
    }
  }

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${directory}/${entry.name}`);

  await Promise.all(directories.map((name) => assertNoSymbolicLinks(packageRoot, name)));
};

// A linked src/ would let the bundle read a tree that the key never scans.
const assertSourceRootIsNotLink = async (packageRoot: string): Promise<void> => {
  const stats = await lstat(join(packageRoot, 'src'));

  if (stats.isSymbolicLink()) {
    throw new Error('Tau artifact input src is a symbolic link.');
  }
};

const listSourceInputs = async (
  packageRoot: string,
  directory: string,
  isSourceRoot: boolean,
): Promise<InputFile[]> => {
  const entries = await readdir(join(packageRoot, directory), { withFileTypes: true });

  // Rolldown resolves a request through this manifest, so the key cannot cover what the bundle
  // would take from the directory.
  if (!isSourceRoot && holdsOwnManifest(entries)) {
    throw new Error(
      `Tau artifact input ${directory} is a nested package: it holds its own package.json, so the key cannot cover what Rolldown resolves through it.`,
    );
  }

  const listed = await Promise.all(
    entries.map(async (entry) => {
      const name = `${directory}/${entry.name}`;

      if (entry.isDirectory()) {
        return listSourceInputs(packageRoot, name, false);
      }

      if (!entry.isFile()) {
        throw new Error(`Tau artifact input ${name} is not a regular file.`);
      }

      // Rolldown can select a nearer config, and the key covers only the root chain.
      if (entry.name === 'tsconfig.json') {
        throw new Error(
          `Tau artifact input ${name} is a tsconfig.json below the root, whose extends chain the key cannot cover.`,
        );
      }

      return keyedInputSuffixes.has(extname(entry.name))
        ? [{ name, path: join(packageRoot, name) }]
        : [];
    }),
  );

  return listed.flat();
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Copies the JSON string literal that starts at `index`, escapes included.
const copyStringLiteral = (text: string, index: number): { literal: string; next: number } => {
  let end = index + 1;

  while (end < text.length) {
    const character = text[end] ?? '';

    if (character === '\\') {
      end += 2;

      continue;
    }

    if (character === '"') {
      return { literal: text.slice(index, end + 1), next: end + 1 };
    }

    end += 1;
  }

  return { literal: text.slice(index), next: text.length };
};

const withoutComments = (text: string): string => {
  let output = '';
  let index = 0;

  while (index < text.length) {
    const character = text[index] ?? '';
    const following = text[index + 1] ?? '';

    if (character === '"') {
      const { literal, next } = copyStringLiteral(text, index);

      output += literal;
      index = next;

      continue;
    }

    if (character === '/' && following === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }

      continue;
    }

    if (character === '/' && following === '*') {
      const end = text.indexOf('*/', index + 2);

      index = end === -1 ? text.length : end + 2;

      continue;
    }

    output += character;
    index += 1;
  }

  return output;
};

const startsObjectOrArrayEnd = (text: string, index: number): boolean => {
  let next = index;

  while (next < text.length && /\s/u.test(text[next] ?? '')) {
    next += 1;
  }

  return text[next] === '}' || text[next] === ']';
};

const withoutTrailingCommas = (text: string): string => {
  let output = '';
  let index = 0;

  while (index < text.length) {
    const character = text[index] ?? '';

    if (character === '"') {
      const { literal, next } = copyStringLiteral(text, index);

      output += literal;
      index = next;

      continue;
    }

    if (character === ',' && startsObjectOrArrayEnd(text, index + 1)) {
      index += 1;

      continue;
    }

    output += character;
    index += 1;
  }

  return output;
};

const withoutByteOrderMark = (text: string): string =>
  text.startsWith('\uFEFF') ? text.slice(1) : text;

// A tsconfig may hold comments and trailing commas, which `JSON.parse` rejects, and Rolldown
// accepts a leading byte order mark.
const parseJsonConfig = (name: string, content: string): Record<string, unknown> => {
  let parsed: unknown;

  try {
    const withoutMark = withoutByteOrderMark(content);

    parsed = JSON.parse(withoutTrailingCommas(withoutComments(withoutMark)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Cannot read ${name}: ${message}`, { cause: error });
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`Cannot read ${name}: it is not a JSON object.`);
  }

  return parsed;
};

const extendsTargets = (name: string, config: Record<string, unknown>): string[] => {
  const value = config['extends'];

  if (value === undefined) {
    return [];
  }

  return (Array.isArray(value) ? value : [value]).map((target) => {
    if (typeof target !== 'string') {
      throw new TypeError(
        `Cannot read the tsconfig extends chain of ${name}: a target is not a path.`,
      );
    }

    return target;
  });
};

// A relative path leaves the parent through a `..` segment, not through a name that starts with
// two dots, such as `..base.json`.
const isInside = (parent: string, child: string): boolean => {
  const relativePath = relative(parent, child);
  const escapes = relativePath === '..' || relativePath.startsWith(`..${sep}`);

  return relativePath !== '' && !escapes && !isAbsolute(relativePath);
};

const resolveExtendsTarget = (packageRoot: string, from: string, target: string): string => {
  if (!target.startsWith('.') && !isAbsolute(target)) {
    throw new Error(
      `Cannot read the tsconfig extends chain: ${target} in ${from} is outside the package.`,
    );
  }

  const resolved = resolve(dirname(from), target);
  const candidate = existsSync(resolved) ? resolved : `${resolved}.json`;

  if (!isInside(packageRoot, candidate)) {
    throw new Error(
      `Cannot read the tsconfig extends chain: ${target} in ${from} is outside the package.`,
    );
  }

  if (!existsSync(candidate)) {
    throw new Error(`Cannot read the tsconfig extends chain: ${target} in ${from} is missing.`);
  }

  return candidate;
};

// A config can be a link that leaves the package while its lexical path stays inside.
const assertPhysicalContainment = async (
  realRoot: string,
  path: string,
  name: string,
): Promise<void> => {
  const real = await realpath(path).catch(() => undefined);

  if (real !== undefined && !isInside(realRoot, real)) {
    throw new Error(`Cannot read ${name}: it resolves outside the package.`);
  }
};

const extendedConfigs = async (
  packageRoot: string,
  realRoot: string,
  path: string,
): Promise<InputFile[]> => {
  const name = relative(packageRoot, path).split(sep).join('/');

  await assertPhysicalContainment(realRoot, path, name);

  const content = await readFile(path, 'utf8').catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Cannot read ${name}: ${message}`);
  });

  return extendsTargets(name, parseJsonConfig(name, content)).map((target) => {
    const resolved = resolveExtendsTarget(packageRoot, path, target);

    return { name: relative(packageRoot, resolved).split(sep).join('/'), path: resolved };
  });
};

const readChain = async (
  packageRoot: string,
  realRoot: string,
  paths: readonly string[],
  visited: Set<string>,
  inputs: readonly InputFile[],
): Promise<InputFile[]> => {
  const pending = paths.filter((path) => !visited.has(path));

  if (pending.length === 0) {
    return [...inputs];
  }

  for (const path of pending) {
    visited.add(path);
  }

  const listed = await Promise.all(
    pending.map((path) => extendedConfigs(packageRoot, realRoot, path)),
  );

  const found = listed.flat();

  return readChain(
    packageRoot,
    realRoot,
    found.map((input) => input.path),
    visited,
    [...inputs, ...found],
  );
};

// Rolldown reads the tsconfig to pick its transforms, so every file the chain reaches is an input.
const tsconfigChainInputs = async (packageRoot: string): Promise<InputFile[]> => {
  const realRoot = await realpath(packageRoot);

  return readChain(packageRoot, realRoot, [join(packageRoot, 'tsconfig.json')], new Set(), []);
};

// Rolldown reads the manifest beside a keyed file outside src/ to decide `sideEffects`, and the key
// cannot cover that manifest. The root manifest is keyed, so only directories below it are checked.
const assertNoNestedManifests = (packageRoot: string, inputs: readonly InputFile[]): void => {
  const sourceRoot = join(packageRoot, 'src');

  for (const { path } of inputs) {
    if (path.startsWith(`${sourceRoot}${sep}`)) {
      continue;
    }

    let directory = dirname(path);

    while (directory !== packageRoot && isInside(packageRoot, directory)) {
      const manifest = join(directory, 'package.json');

      if (existsSync(manifest)) {
        const name = relative(packageRoot, manifest).split(sep).join('/');

        throw new Error(
          `Tau artifact input ${name} is a nested package manifest, so the key cannot cover what Rolldown resolves through it.`,
        );
      }

      directory = dirname(directory);
    }
  }
};

const readInputDigest = async ({ name, path }: InputFile): Promise<string> => {
  const content = await readFile(path).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Cannot read Tau artifact input ${name}: ${message}`);
  });

  const digest = createHash('sha256').update(content).digest('hex');

  return `${name}\u0000${digest}`;
};

// The key covers every file whose bytes can change the bundle. It never reads Git, runs a build, or
// reads user configuration.
export const readTauArtifactInputs = async (packageRoot: string): Promise<TauArtifactInputs> => {
  const fixed = fixedInputs.map((name) => ({ name, path: join(packageRoot, name) }));

  await assertSourceRootIsNotLink(packageRoot);
  await assertNoSymbolicLinks(packageRoot, 'src');

  const sources = await listSourceInputs(packageRoot, 'src', true);
  const chain = await tsconfigChainInputs(packageRoot);

  const inputs = uniqueInputs([...fixed, ...sources, ...chain]).toSorted(compareNames);

  assertNoNestedManifests(packageRoot, inputs);

  const digests = await Promise.all(inputs.map((input) => readInputDigest(input)));
  const key = createHash('sha256').update(digests.join('\n')).digest('hex');

  return { key, inputPaths: inputs.map((input) => input.path).toSorted() };
};

export const readTauArtifactKey = async (packageRoot: string): Promise<string> => {
  const { key } = await readTauArtifactInputs(packageRoot);

  return key;
};

export const tauArtifactPath = (packageRoot: string, key: string): string => {
  if (!artifactKeyPattern.test(key)) {
    throw new Error(`Tau artifact key ${key} is not a SHA-256 digest.`);
  }

  return join(packageRoot, 'dist', 'tau', `${key}.mts`);
};
