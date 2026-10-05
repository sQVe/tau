import { posix } from 'node:path';

import type { ESTree, Rule } from '@oxlint/plugins';

interface FolderModule {
  // The module folder below src/, such as models or extensions/subagents.
  folder: string;
  // The file below the module folder, without its extension.
  file: string;
}

// Folders that group files under src/ without forming a module.
const groupingFolders = new Set(['extensions', 'skills', 'instructions']);

// Files a folder module exposes besides its entry, named without the extension.
const publicFiles = new Set([
  'extensions/subagents/controller/controller',
  'extensions/subagents/controller/record',
  'extensions/subagents/controller/budget',
  'reviewCapture/evidence',
  'reviewCapture/record',
]);

const withoutExtension = (name: string): string => name.replace(/\.[jt]s$/, '');

const sourceRootOf = (path: string): string | undefined => {
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

const folderModuleOf = (segments: string[]): FolderModule | undefined => {
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
  file === posix.basename(folder) || publicFiles.has(`${folder}/${file}`);

const mayImportPrivateFiles = (segments: string[]): boolean =>
  (segments.at(-1) ?? '').endsWith('.test.ts') || segments.includes('fixtures');

export const extensionBoundaryRule: Rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      crossing:
        'Extension "{{source}}" must not import from extension "{{target}}". Move shared code under src/.',
      root: 'Module "{{source}}" must not import src/tau.ts, which loads every extension.',
      private:
        'Import module "{{folder}}" through its entry file, not its private file "{{file}}". Make the file public in the extension-boundary rule if other modules depend on it.',
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
    const sourceExtension = extensionOf(ownSegments);
    const sourceModule = folderModuleOf(ownSegments)?.folder;
    const sourceName = sourceExtension ?? withoutExtension(ownSegments[0] ?? '');
    const checksPrivateFiles = !mayImportPrivateFiles(ownSegments);

    const checkPrivateFile = (node: ESTree.Node, target: string[]) => {
      const targetModule = folderModuleOf(target);

      if (targetModule === undefined || targetModule.folder === sourceModule) {
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

    const check = (node: ESTree.Node, specifier: unknown) => {
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
        return;
      }

      const target = segmentsOf(posix.join(posix.dirname(filename), specifier));

      if (target === undefined) {
        return;
      }

      if (checksPrivateFiles) {
        checkPrivateFile(node, target);
      }

      if (isCompositionRoot(target)) {
        context.report({ node, messageId: 'root', data: { source: sourceName } });
      } else if (sourceExtension !== undefined) {
        checkExtensionBoundary(node, target, sourceExtension);
      }
    };

    return {
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
        check(node, node.source.type === 'Literal' ? node.source.value : undefined);
      },
    };
  },
};
