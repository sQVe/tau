import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { rolldown } from '@voidzero-dev/vite-plus-core/rolldown';
import { parseSync } from '@voidzero-dev/vite-plus-core/rolldown/utils';

import {
  readTauArtifactInputs,
  readTauArtifactKey,
  tauArtifactPath,
} from '../src/tau/tauArtifact.ts';

type AstNode = Record<string, unknown>;

interface UrlEdit {
  start: number;
  end: number;
}

const sourceEntry = 'src/tau/tau.ts';

const isBareImport = (id: string): boolean =>
  !id.startsWith('.') && !id.startsWith('\u0000') && !isAbsolute(id);

const isAstNode = (value: unknown): value is AstNode => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('type' in value)) {
    return false;
  }

  return typeof value.type === 'string';
};

const nodeType = (node: AstNode): string => String(node.type);

const identifierName = (node: unknown): string | undefined => {
  if (!isAstNode(node) || nodeType(node) !== 'Identifier') {
    return undefined;
  }

  const name = node.name;

  return typeof name === 'string' ? name : undefined;
};

const isMetaProperty = (node: unknown): boolean =>
  isAstNode(node) && nodeType(node) === 'MetaProperty' && identifierName(node.meta) === 'import';

const isMetaUrl = (node: AstNode): boolean => {
  if (nodeType(node) !== 'MemberExpression' || node.computed === true) {
    return false;
  }

  if (!isMetaProperty(node.object)) {
    return false;
  }

  return identifierName(node.property) === 'url';
};

const childNodes = (node: AstNode): AstNode[] =>
  Object.values(node).flatMap((value) => {
    if (Array.isArray(value)) {
      return value.filter(isAstNode);
    }

    return isAstNode(value) ? [value] : [];
  });

const nodeRange = (node: AstNode): UrlEdit => {
  const { start, end } = node;

  if (typeof start !== 'number' || typeof end !== 'number') {
    throw new TypeError('The parser returned a node without a source range.');
  }

  return { start, end };
};

const isUrlBase = (node: AstNode, parent: AstNode): boolean => {
  if (nodeType(parent) !== 'NewExpression' || identifierName(parent.callee) !== 'URL') {
    return false;
  }

  const args = parent.arguments;

  return Array.isArray(args) && args[1] === node;
};

// A literal asset URL must already exist beside the module, so a wrong relative path fails the
// build instead of a later load.
const assertStaticTarget = (parent: AstNode, id: string): void => {
  const args = parent.arguments;

  if (!Array.isArray(args)) {
    return;
  }

  const target: unknown = args[0];

  if (!isAstNode(target) || nodeType(target) !== 'Literal') {
    return;
  }

  const value = target.value;

  if (typeof value !== 'string') {
    return;
  }

  const resolved = new URL(value, pathToFileURL(id));

  if (!existsSync(fileURLToPath(resolved))) {
    throw new Error(`Missing ${value} beside ${id}.`);
  }
};

// Lists each `import.meta.url` in the module and refuses any other `import.meta` form.
const importMetaUrls = (source: string, id: string): UrlEdit[] => {
  const { program, errors } = parseSync(id, source);

  if (errors.length > 0) {
    throw new Error(`Cannot parse ${id}: ${errors[0]?.message ?? 'unknown error'}`);
  }

  if (!isAstNode(program)) {
    throw new Error(`Cannot read the syntax tree of ${id}.`);
  }

  const edits: UrlEdit[] = [];

  const visit = (node: AstNode, parent: AstNode | undefined): void => {
    if (isMetaProperty(node) && !(parent !== undefined && isMetaUrl(parent))) {
      throw new Error(
        `Unsupported import.meta form in ${id}: only import.meta.url can be rebased.`,
      );
    }

    if (isMetaUrl(node)) {
      if (parent !== undefined && isUrlBase(node, parent)) {
        assertStaticTarget(parent, id);
      }

      edits.push(nodeRange(node));
    }

    for (const child of childNodes(node)) {
      visit(child, node);
    }
  };

  visit(program, undefined);

  return edits;
};

const rebaseImportMetaUrl = (source: string, id: string, artifactUrl: URL): string => {
  if (!source.includes('import.meta')) {
    return source;
  }

  const anchor = relative(dirname(fileURLToPath(artifactUrl)), id)
    .split(sep)
    .map(encodeURIComponent)
    .join('/');

  if (new URL(anchor, artifactUrl).href !== pathToFileURL(id).href) {
    throw new Error(`Cannot rebase import.meta.url in ${id}.`);
  }

  let output = source;

  for (const edit of importMetaUrls(source, id).toReversed()) {
    const replacement = `(new URL(${JSON.stringify(anchor)}, import.meta.url).href)`;

    output = `${output.slice(0, edit.start)}${replacement}${output.slice(edit.end)}`;
  }

  return output;
};

// The key inventory is the only set of files the bundle may take. A module outside it could change
// without changing the key.
const membershipPlugin = (inventory: ReadonlySet<string>) => ({
  name: 'tau-check-module-membership',
  // The resolved file is the module the bundle takes, so inventory membership decides coverage.
  transform(_code: string, id: string): undefined {
    if (id.startsWith('\u0000') || inventory.has(resolve(id))) {
      return undefined;
    }

    throw new Error(`Cannot bundle ${id}, which is outside the artifact key.`);
  },
});

const rebasePlugin = (packageRoot: string, artifactUrl: URL) => {
  const sourceRoot = join(packageRoot, 'src');

  return {
    name: 'tau-rebase-import-meta',
    transform(code: string, id: string): { code: string; map: null } | undefined {
      if (!id.startsWith(`${sourceRoot}/`)) {
        return undefined;
      }

      // A JSON module is data, so it holds no import.meta to rebase.
      if (extname(id) === '.json') {
        return undefined;
      }

      return { code: rebaseImportMetaUrl(code, id, artifactUrl), map: null };
    },
  };
};

const bundleCode = async (
  packageRoot: string,
  key: string,
  inputPaths: readonly string[],
): Promise<string> => {
  const artifactUrl = pathToFileURL(tauArtifactPath(packageRoot, key));
  const inventory = new Set(inputPaths.map((path) => resolve(path)));

  const bundle = await rolldown({
    // Region comments are relative to this directory, so the artifact bytes do not depend on the
    // caller's working directory.
    cwd: packageRoot,
    input: join(packageRoot, sourceEntry),
    platform: 'node',
    external: isBareImport,
    // The bundle takes only relative modules from this package, so no manifest may redirect a
    // request into code the key does not cover. A symlink keeps its link path, so a manifest beside
    // that path cannot decide the output without being keyed.
    resolve: { exportsFields: [], mainFields: [], symlinks: false },
    onLog: (level, log, defaultHandler) => {
      if (level === 'warn') {
        throw new Error(`Cannot bundle Tau: ${log.code} ${log.message}`);
      }

      defaultHandler(level, log);
    },
    plugins: [membershipPlugin(inventory), rebasePlugin(packageRoot, artifactUrl)],
  });

  try {
    const { output } = await bundle.generate({
      format: 'es',
      sourcemap: false,
      minify: false,
      // A literal dynamic import of a keyed module must not leave the single artifact.
      codeSplitting: false,
    });

    // `watchFiles` is experimental in the pinned Rolldown version, so this check covers the input
    // classes the tests exercise. It runs before any output is accepted or written.
    const watched = await bundle.watchFiles;
    const unkeyed = watched.filter((path) => !inventory.has(resolve(path)));

    if (unkeyed.length > 0) {
      throw new Error(`Cannot bundle ${unkeyed[0] ?? ''}, which is outside the artifact key.`);
    }

    const first = output[0];

    if (output.length !== 1) {
      throw new Error('The Tau artifact must be one chunk.');
    }

    if (first.exports.length !== 1 || first.exports[0] !== 'default') {
      throw new Error('The Tau artifact must have one default export.');
    }

    if (first.code.includes(packageRoot)) {
      throw new Error('The Tau artifact embeds the checkout path.');
    }

    const localImports = [...first.imports, ...first.dynamicImports].filter(
      (id) => !isBareImport(id),
    );

    if (localImports.length > 0) {
      throw new Error(`The Tau artifact leaves ${localImports[0] ?? ''} outside the bundle.`);
    }

    const foreignModules = Object.keys(first.modules).filter(
      (id) => !id.startsWith('\u0000') && !inventory.has(resolve(id)),
    );

    if (foreignModules.length > 0) {
      throw new Error(
        `The Tau artifact bundles ${foreignModules[0] ?? ''}, which is outside the artifact key.`,
      );
    }

    return first.code;
  } finally {
    await bundle.close();
  }
};

export const writeTauArtifact = async (
  packageRoot: string,
  key: string,
  code: string,
): Promise<string> => {
  const target = tauArtifactPath(packageRoot, key);

  await mkdir(dirname(target), { recursive: true });

  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;

  await writeFile(temporary, code);

  const current = await readTauArtifactKey(packageRoot).catch(() => undefined);

  if (current !== key) {
    await rm(temporary, { force: true });

    throw new Error('Tau sources changed during the build, so no artifact was published.');
  }

  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });

    throw error;
  }

  return target;
};

// The build always bundles, so it refuses inputs the key cannot cover even when an artifact already
// sits at the key. A complete artifact for the exact key is not rewritten.
export const buildTauExtension = async (packageRoot: string): Promise<string> => {
  const { key, inputPaths } = await readTauArtifactInputs(packageRoot);
  const target = tauArtifactPath(packageRoot, key);
  const code = await bundleCode(packageRoot, key, inputPaths);

  if (existsSync(target)) {
    return target;
  }

  return writeTauArtifact(packageRoot, key, code);
};

const main = async (): Promise<void> => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const target = await buildTauExtension(packageRoot);

  process.stdout.write(`Tau artifact: ${relative(packageRoot, target)}\n`);
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    process.stderr.write(`Cannot build the Tau artifact: ${message}\n`);
    process.exitCode = 1;
  }
}
