import { existsSync } from 'node:fs';
import { posix } from 'node:path';

import type { ESTree, Rule } from '@oxlint/plugins';

interface ModuleDeclaration {
  name: string;
  entry: string;
  publicFiles: readonly string[];
}

interface FolderModule {
  // The module folder below src/, such as models or extensions/subagents.
  folder: string;
  // The file below the module folder, without its extension.
  file: string;
}

// Folders that group files under src/ without forming a module.
const groupingFolders = new Set(['extensions', 'skills']);

// Every module under src/ that is not an extension. A module is one flat file or one folder.
// name is the path below src/ without the extension. entry and publicFiles are paths below src/
// without the extension; other files of a folder module are private.
export const moduleList: readonly ModuleDeclaration[] = [
  {
    name: 'checkRecord',
    entry: 'checkRecord/checkRecord',
    publicFiles: ['checkRecord/identity', 'checkRecord/reuseDecision'],
  },
  {
    name: 'codemode',
    entry: 'codemode/codemode',
    publicFiles: ['codemode/controlTools', 'codemode/fullOutput'],
  },
  { name: 'command', entry: 'command', publicFiles: [] },
  {
    name: 'config',
    entry: 'config/config',
    publicFiles: [
      'config/fullCheck',
      'config/models',
      'config/repositoryEntry',
      'config/repositorySection',
    ],
  },
  { name: 'dialog', entry: 'dialog/dialog', publicFiles: ['dialog/box', 'dialog/keys'] },
  { name: 'errors', entry: 'errors', publicFiles: [] },
  {
    name: 'extensions/subagents/controller',
    entry: 'extensions/subagents/controller/controller',
    publicFiles: [
      'extensions/subagents/controller/budget',
      'extensions/subagents/controller/controller',
      'extensions/subagents/controller/record',
    ],
  },
  { name: 'fileLock', entry: 'fileLock/fileLock', publicFiles: [] },
  { name: 'git', entry: 'git', publicFiles: [] },
  {
    name: 'github',
    entry: 'github/github',
    publicFiles: ['github/repositoryTarget', 'github/repositoryTargetDecisions'],
  },
  { name: 'herdr', entry: 'herdr', publicFiles: [] },
  {
    name: 'instructions',
    entry: 'instructions/instructions',
    publicFiles: ['instructions/systemPrompt'],
  },
  { name: 'linear', entry: 'linear', publicFiles: [] },
  { name: 'process', entry: 'process/process', publicFiles: [] },
  { name: 'record', entry: 'record', publicFiles: [] },
  {
    name: 'reviewCapture',
    entry: 'reviewCapture/reviewCapture',
    publicFiles: ['reviewCapture/evidence'],
  },
  { name: 'schema', entry: 'schema', publicFiles: [] },
  { name: 'skillTools', entry: 'skillTools', publicFiles: [] },
  { name: 'tau', entry: 'tau', publicFiles: [] },
  { name: 'tauDirectory', entry: 'tauDirectory', publicFiles: [] },
  { name: 'worker', entry: 'worker', publicFiles: [] },
];

// The shared modules each module may import, one row per module. src/tau.ts is the composition
// root and has no row.
export const importTable: Readonly<Record<string, readonly string[]>> = {
  checkRecord: ['errors', 'git', 'record'],
  codemode: [],
  command: ['schema'],
  config: ['errors', 'schema'],
  dialog: ['worker'],
  errors: [],
  fileLock: ['errors', 'process', 'schema'],
  git: ['errors'],
  github: ['command', 'errors', 'git', 'schema'],
  herdr: [],
  instructions: [],
  linear: ['command', 'errors'],
  process: ['errors'],
  record: ['errors', 'schema', 'tauDirectory'],
  reviewCapture: ['errors', 'git', 'record', 'schema', 'tauDirectory'],
  schema: [],
  skillTools: [],
  tauDirectory: ['errors', 'git'],
  worker: ['schema'],
};

const publicPaths = new Set(moduleList.flatMap((module) => [module.entry, ...module.publicFiles]));

const withoutExtension = (name: string): string => name.replace(/\.[jt]s$/, '');

const packageRoots = new Map<string, string | undefined>();

const packageRootOf = (directory: string): string | undefined => {
  if (packageRoots.has(directory)) {
    return packageRoots.get(directory);
  }

  const parent = posix.dirname(directory);
  let found: string | undefined;

  if (existsSync(`${directory}/package.json`)) {
    found = directory;
  } else if (parent !== directory) {
    found = packageRootOf(parent);
  }

  packageRoots.set(directory, found);

  return found;
};

// The src folder of the package that holds the file. Without a package.json above the file, the
// last src folder in the path counts.
const sourceRootOf = (path: string): string | undefined => {
  const packageRoot = packageRootOf(posix.dirname(path));

  if (packageRoot !== undefined) {
    return path.startsWith(`${packageRoot}/src/`) ? `${packageRoot}/src` : undefined;
  }

  const segments = path.split('/');
  const index = segments.lastIndexOf('src');

  return index === -1 ? undefined : segments.slice(0, index + 1).join('/');
};

// The extension a file belongs to: src/extensions/<name>.ts or a file in src/extensions/<name>/.
const extensionOf = (segments: string[]): string | undefined => {
  const name = segments[1];

  if (segments[0] !== 'extensions' || name === undefined) {
    return undefined;
  }

  return segments.length === 2 ? name.split('.')[0] : name;
};

// src/tau.ts loads every extension, so importing it crosses every boundary at once.
const isCompositionRoot = (segments: string[]): boolean =>
  segments.length === 1 && withoutExtension(segments[0] ?? '') === 'tau';

// The most specific declared module that contains the path, such as a nested controller folder
// inside an extension.
const moduleOf = (segments: string[]): ModuleDeclaration | undefined => {
  const path = withoutExtension(segments.join('/'));

  const containing = moduleList.filter(
    (module) => path === module.name || path.startsWith(`${module.name}/`),
  );

  return containing.toSorted((first, second) => second.name.length - first.name.length)[0];
};

const folderModuleOf = (segments: string[]): FolderModule | undefined => {
  const declared = moduleOf(segments);
  const path = withoutExtension(segments.join('/'));

  if (declared !== undefined && path.startsWith(`${declared.name}/`)) {
    return { folder: declared.name, file: path.slice(declared.name.length + 1) };
  }

  const depth = segments[0] === 'extensions' ? 2 : 1;
  const isGrouped = depth === 1 && groupingFolders.has(segments[0] ?? '');

  if (segments.length <= depth || isGrouped) {
    return undefined;
  }

  const folder = segments.slice(0, depth).join('/');
  const file = withoutExtension(segments.slice(depth).join('/'));

  return { folder, file };
};

const isPublicFile = ({ folder, file }: FolderModule): boolean =>
  file === posix.basename(folder) || publicPaths.has(`${folder}/${file}`);

// Folders whose files are data or test support, not modules.
const exemptFolders = new Set(['fixtures', 'profiles', 'snippets']);

// An extension's own folder may share a name with an exempt folder, so skip it.
const isExempt = (segments: string[]): boolean => {
  const ownFolderDepth = extensionOf(segments) === undefined || segments.length === 2 ? 0 : 2;
  const folders = segments.slice(ownFolderDepth, -1);

  return segments[0] === 'skills' || folders.some((folder) => exemptFolders.has(folder));
};

const isTestFile = (segments: string[]): boolean => (segments.at(-1) ?? '').endsWith('.test.ts');

const describeSource = (segments: string[]) => {
  const sourceExtension = extensionOf(segments);
  const sourceDeclaration = sourceExtension === undefined ? moduleOf(segments) : undefined;
  const sharedSource = sourceDeclaration?.name === 'tau' ? undefined : sourceDeclaration;

  return {
    sourceExtension,
    sourceFolder: folderModuleOf(segments)?.folder,
    sourceDeclaration,
    sharedSource,
    sourceName: sourceExtension ?? sourceDeclaration?.name ?? segments.join('/'),
  };
};

export const moduleBoundariesRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      crossing:
        'Extension "{{source}}" must not import from extension "{{target}}". Move shared code under src/.',
      root: 'Module "{{source}}" must not import src/tau.ts, which loads every extension.',
      private:
        'Import module "{{folder}}" through its entry file, not its private file "{{file}}". Make the file public in the module list of the module-boundaries rule if other modules depend on it.',
      unknownFile:
        'File "{{file}}" is not in a module. Add its module to the module list in lint/rules/moduleBoundaries.ts.',
      notAllowed:
        'Module "{{source}}" must not import module "{{target}}". Add the edge to the import table in lint/rules/moduleBoundaries.ts if it is intended.',
      sharedToExtension:
        'Module "{{source}}" must not import extension "{{target}}". Extensions depend on shared modules, not the reverse.',
      computedImport:
        'Import a literal path so the module rules can follow it. A computed import() hides its target.',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    const sourceRoot = sourceRootOf(filename);

    if (sourceRoot === undefined) {
      return {};
    }

    // Paths below the importer's src/ folder; anything else is outside the package source.
    const segmentsOf = (path: string): string[] | undefined =>
      path.startsWith(`${sourceRoot}/`) ? path.slice(sourceRoot.length + 1).split('/') : undefined;

    const ownSegments = segmentsOf(filename) ?? [];

    // Tests and support files skip the private-file, import table, and unknown-file checks, but
    // still obey the extension and src/tau.ts boundaries.
    const isSupportFile = isTestFile(ownSegments) || isExempt(ownSegments);

    const { sourceExtension, sourceFolder, sourceDeclaration, sharedSource, sourceName } =
      describeSource(ownSegments);

    const isUnknownFile =
      !isSupportFile && sourceExtension === undefined && sourceDeclaration === undefined;

    const allowedTargets = importTable[sharedSource?.name ?? ''] ?? [];

    // A module may use its own files and the files of the folders that contain it.
    const containsSource = (folder: string): boolean =>
      sourceFolder === folder || sourceFolder?.startsWith(`${folder}/`) === true;

    const checkPrivateFile = (node: ESTree.Node, target: string[]) => {
      const targetModule = folderModuleOf(target);

      if (targetModule === undefined || containsSource(targetModule.folder)) {
        return;
      }

      if (!isPublicFile(targetModule)) {
        context.report({ node, messageId: 'private', data: { ...targetModule } });
      }
    };

    const checkExtensionBoundary = (node: ESTree.Node, target: string[], source: string) => {
      const targetExtension = extensionOf(target);

      if (targetExtension !== undefined && targetExtension !== source) {
        context.report({
          node,
          messageId: 'crossing',
          data: { source, target: targetExtension },
        });
      }
    };

    // Reports shared modules only; src/tau.ts is the one shared file that may load extensions.
    const checkSharedImport = (node: ESTree.Node, target: string[], source: ModuleDeclaration) => {
      const targetExtension = extensionOf(target);

      if (targetExtension !== undefined) {
        context.report({
          node,
          messageId: 'sharedToExtension',
          data: { source: source.name, target: targetExtension },
        });

        return;
      }

      const targetModule = moduleOf(target);
      const isListed = targetModule === undefined || allowedTargets.includes(targetModule.name);

      if (targetModule !== source && !isListed) {
        context.report({
          node,
          messageId: 'notAllowed',
          data: { source: source.name, target: targetModule.name },
        });
      }
    };

    const check = (node: ESTree.Node, specifier: unknown) => {
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
        return;
      }

      const target = segmentsOf(posix.join(posix.dirname(filename), specifier));

      if (target === undefined) {
        return;
      }

      if (!isSupportFile) {
        checkPrivateFile(node, target);
      }

      if (isCompositionRoot(target)) {
        context.report({ node, messageId: 'root', data: { source: sourceName } });
      } else if (sourceExtension !== undefined) {
        checkExtensionBoundary(node, target, sourceExtension);
      } else if (sharedSource !== undefined && !isSupportFile) {
        checkSharedImport(node, target, sharedSource);
      }
    };

    return {
      Program(node) {
        if (isUnknownFile) {
          context.report({ node, messageId: 'unknownFile', data: { file: ownSegments.join('/') } });
        }
      },
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        check(node, node.source?.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') {
          check(node, node.source.value);
        } else if (!isSupportFile) {
          context.report({ node, messageId: 'computedImport' });
        }
      },
    };
  },
};
