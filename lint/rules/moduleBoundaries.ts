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
  { name: 'classifier', entry: 'classifier/classifier', publicFiles: [] },
  {
    name: 'codemode',
    entry: 'codemode/codemode',
    publicFiles: ['codemode/controlTools', 'codemode/fullOutput', 'codemode/guidelines'],
  },
  { name: 'command', entry: 'command', publicFiles: [] },
  {
    name: 'config',
    entry: 'config/config',
    publicFiles: [
      'config/models',
      'config/questionGateModels',
      'config/repositoryCommand',
      'config/repositoryEntry',
      'config/repositorySection',
      'config/roleModels',
      'config/verificationTargets',
    ],
  },
  {
    name: 'dialog',
    entry: 'dialog/dialog',
    publicFiles: ['dialog/blockedStatus', 'dialog/box', 'dialog/keys'],
  },
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
  {
    name: 'extensions/tdd/runner',
    entry: 'extensions/tdd/runner/vitest',
    publicFiles: [
      'extensions/tdd/runner/constants',
      'extensions/tdd/runner/report',
      'extensions/tdd/runner/retention',
      'extensions/tdd/runner/runners',
      'extensions/tdd/runner/testNames',
      'extensions/tdd/runner/types',
      'extensions/tdd/runner/vitest',
    ],
  },
  { name: 'fileLock', entry: 'fileLock/fileLock', publicFiles: [] },
  { name: 'fileText', entry: 'fileText', publicFiles: [] },
  { name: 'git', entry: 'git', publicFiles: [] },
  {
    name: 'github',
    entry: 'github/github',
    publicFiles: [
      'github/mergedPullRequest',
      'github/repositoryTarget',
      'github/repositoryTargetDecisions',
    ],
  },
  { name: 'handoverSender', entry: 'handoverSender', publicFiles: [] },
  { name: 'hc', entry: 'hc/hc', publicFiles: ['hc/connect', 'hc/events'] },
  {
    name: 'improvement',
    entry: 'improvement/improvement',
    publicFiles: [
      'improvement/classIdentity',
      'improvement/correctDecision',
      'improvement/correctSources',
      'improvement/event',
      'improvement/historyRead',
      'improvement/projectRoot',
      'improvement/sessionDirectory',
      'improvement/status',
      'improvement/statusDecision',
      'improvement/sweep',
      'improvement/sweepIndex',
      'improvement/taskMapping',
      'improvement/taskSignals',
      'improvement/taskTranscripts',
      'improvement/transcript',
      'improvement/workerRecord',
    ],
  },
  { name: 'inbox', entry: 'inbox/inbox', publicFiles: ['inbox/receiptDecision'] },
  {
    name: 'instructions',
    entry: 'instructions/instructions',
    publicFiles: [
      'instructions/guideRuns',
      'instructions/languageRules/languageRules',
      'instructions/markdownLinks',
      'instructions/stommeGuides/stommeGuides',
      'instructions/systemPrompt',
    ],
  },
  { name: 'judgeSchema', entry: 'judgeSchema', publicFiles: [] },
  {
    name: 'linear',
    entry: 'linear/linear',
    publicFiles: ['linear/descriptionMatch', 'linear/ownership'],
  },
  {
    name: 'piStart',
    entry: 'piStart/piStart',
    publicFiles: ['piStart/herdrPane', 'piStart/piArguments'],
  },
  { name: 'process', entry: 'process/process', publicFiles: [] },
  { name: 'prose', entry: 'prose', publicFiles: [] },
  {
    name: 'questionGate',
    entry: 'questionGate/questionGate',
    publicFiles: ['questionGate/decision/decision', 'questionGate/examples'],
  },
  { name: 'record', entry: 'record', publicFiles: [] },
  { name: 'reviewBots', entry: 'reviewBots/reviewBots', publicFiles: [] },
  {
    name: 'reviewCapture',
    entry: 'reviewCapture/reviewCapture',
    publicFiles: ['reviewCapture/evidence', 'reviewCapture/reports'],
  },
  { name: 'role', entry: 'role/role', publicFiles: ['role/roleGuidelines', 'role/roleTools'] },
  { name: 'schema', entry: 'schema', publicFiles: [] },
  {
    name: 'sessionMessage',
    entry: 'sessionMessage/sessionMessage',
    publicFiles: ['sessionMessage/askResult'],
  },
  { name: 'shell', entry: 'shell', publicFiles: [] },
  { name: 'skillTools', entry: 'skillTools', publicFiles: [] },
  { name: 'tabName', entry: 'tabName', publicFiles: [] },
  { name: 'tau', entry: 'tau/tau', publicFiles: ['tau/tauArtifact', 'tau/tauSelection'] },
  { name: 'tauDirectory', entry: 'tauDirectory', publicFiles: [] },
  { name: 'terminalText', entry: 'terminalText', publicFiles: [] },
  {
    name: 'verification',
    entry: 'verification/verification',
    publicFiles: ['verification/freshness', 'verification/records', 'verification/selection'],
  },
  { name: 'wake', entry: 'wake/wake', publicFiles: [] },
  { name: 'wrapperAnalysis', entry: 'wrapperAnalysis', publicFiles: [] },
];

// The shared modules each module may import, one row per module. src/tau/tau.ts is the
// composition root and has no row.
export const importTable: Readonly<Record<string, readonly string[]>> = {
  checkRecord: ['errors', 'git', 'record'],
  classifier: ['config'],
  codemode: [],
  command: ['schema'],
  config: ['errors', 'judgeSchema', 'role', 'schema'],
  dialog: ['role'],
  errors: [],
  fileLock: ['errors', 'process', 'schema'],
  fileText: ['errors'],
  git: ['errors'],
  github: ['command', 'errors', 'git', 'schema'],
  handoverSender: [],
  hc: ['command', 'errors', 'schema'],
  improvement: [
    'command',
    'errors',
    'fileLock',
    'git',
    'github',
    'record',
    'schema',
    'sessionMessage',
    'tauDirectory',
  ],
  inbox: ['errors', 'fileLock', 'handoverSender', 'hc', 'record', 'schema', 'wake'],
  instructions: ['errors'],
  judgeSchema: [],
  linear: ['command', 'errors'],
  piStart: ['command', 'config', 'errors', 'git', 'schema'],
  process: ['errors'],
  prose: [],
  questionGate: ['errors', 'judgeSchema', 'schema'],
  record: ['errors', 'schema', 'tauDirectory'],
  reviewBots: ['command', 'config', 'github', 'schema'],
  reviewCapture: ['command', 'errors', 'git', 'github', 'record', 'schema', 'tauDirectory'],
  role: ['schema'],
  schema: [],
  sessionMessage: ['schema'],
  shell: ['wrapperAnalysis'],
  skillTools: [],
  tabName: [],
  tauDirectory: ['errors', 'git'],
  terminalText: [],
  verification: ['errors', 'record', 'schema', 'tauDirectory'],
  wake: [],
  wrapperAnalysis: [],
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

// src/tau/tau.ts loads every extension, so importing it crosses every boundary at once. The
// package entry may import it, because that is how Pi reaches the registration.
const isRegistrationOwner = (segments: string[]): boolean =>
  segments.length === 2 && segments[0] === 'tau' && withoutExtension(segments[1] ?? '') === 'tau';

const isPackageEntry = (segments: string[]): boolean =>
  segments.length === 1 && withoutExtension(segments[0] ?? '') === 'tau';

const isTestFile = (segments: string[]): boolean => (segments.at(-1) ?? '').endsWith('.test.ts');

const crossesEveryBoundary = (segments: string[]): boolean =>
  isPackageEntry(segments) || isRegistrationOwner(segments);

// The artifact path is a content hash, so only the loader may import it through a computed path.
const isTauLoader = (segments: string[]): boolean =>
  segments.length === 2 &&
  segments[0] === 'tau' &&
  withoutExtension(segments[1] ?? '') === 'tauSelection';

// The package entry reaches the registration owner, and only the package entry may.
const isRegistrationEntry = (source: string[], target: string[]): boolean =>
  isPackageEntry(source) && isRegistrationOwner(target);

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
  const fileSegment = segments.slice(depth).join('/');
  const file = withoutExtension(fileSegment);

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

const describeSource = (segments: string[]) => {
  const sourceExtension = extensionOf(segments);
  const sourceDeclaration = sourceExtension === undefined ? moduleOf(segments) : undefined;

  // The registration owner installs every extension, so it alone skips the shared-module rules.
  // Another file in the tau module still follows them.
  const sharedSource = isRegistrationOwner(segments) ? undefined : sourceDeclaration;

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
      root: 'Module "{{source}}" must not import src/tau.ts or src/tau/tau.ts, which load every extension.',
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
    // still obey the extension and registration boundaries.
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

    // Reports shared modules only; the registration owner is the one shared file that may load
    // extensions.
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

      if (crossesEveryBoundary(target) && !isRegistrationEntry(ownSegments, target)) {
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
        } else if (!isSupportFile && !isTauLoader(ownSegments)) {
          context.report({ node, messageId: 'computedImport' });
        }
      },
    };
  },
};
