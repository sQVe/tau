import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSync, Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  BindingPattern,
  BindingRestElement,
  BlockStatement,
  CallExpression,
  Class,
  Expression,
  Function,
  MemberExpression,
  ModuleDeclaration,
  NewExpression,
  ParamPattern,
  Program,
  Statement,
  TSParameterProperty,
  VariableDeclaration,
  VisitorObject,
} from 'oxc-parser';
import { expect, it } from 'vitest';

import { importTable, moduleList } from '../lint/rules/moduleBoundaries.ts';
import config, { testEnvironment, testManagedEnvironment } from '../vite.config.ts';

type BindingKind = 'escaping' | 'function' | 'local';

interface BindingScope {
  bindings: Map<string, BindingKind>;
  functionScope: boolean;
}

const root = fileURLToPath(new URL('../', import.meta.url));

// Local state, such as review captures under .pi/, can hold test files that no project runs.
const ignoredDirectories = new Set(['node_modules', '.git', '.tau', '.pi', 'dist', 'coverage']);

// Skips ignored directories before descending, so state that appears and vanishes there, such as
// .pi/format-probe-*, is never read. A directory removed during the walk counts as empty.
const walkRepository = (directory: string): string[] => {
  let entries: Dirent[];

  try {
    entries = readdirSync(join(root, directory), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  return entries.flatMap((entry) => {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`;

    if (ignoredDirectories.has(entry.name)) {
      return [];
    }

    return entry.isDirectory() ? walkRepository(path) : [path];
  });
};

const repositoryFiles = () => walkRepository('');

const sourceFiles = walkRepository('src').filter((path) => path.endsWith('.ts'));

const isTest = (path: string) => path.endsWith('.test.ts');
// A relative path through fixtures/, or the bare segment passed to join(); globs and prose do not load.
const fixtureLoad = /['"`](?:\.{1,2}\/(?:[^'"`]*\/)?fixtures(?:\/[^'"`]*)?|fixtures)['"`]/;
const isFixture = (path: string) => path.split(/[/\\]/).includes('fixtures');

// Pure decision modules take every read, clock, and environment value as a fact from the caller.
// Register a module here once its decisions are split from its reads.
const pureModules = [
  'scripts/pathCommands.ts',
  'scripts/piSessionRules.ts',
  'scripts/piSmokeChecks.ts',
  'scripts/piVersionDrift.ts',
  'scripts/proseReport/proseReportSummary.ts',
  'scripts/questionGateScore/questionGateScoreLog.ts',
  'scripts/questionGateScore/questionGateScorePrepare.ts',
  'scripts/questionGateScore/questionGateScoreReport.ts',
  'scripts/questionGateScore/sessionLowerBound.ts',
  'scripts/questionGateScore/shadowReport.ts',
  'scripts/sessionHealthReport.ts',
  'scripts/sessionHealthRules.ts',
  'scripts/tokenUsageReport.ts',
  'src/checkRecord/reuseDecision.ts',
  'src/codemode/budget.ts',
  'src/codemode/controlTools.ts',
  'src/codemode/outputCuts.ts',
  'src/codemode/outputRetention.ts',
  'src/codemode/outputSegments.ts',
  'src/config/allowedModels.ts',
  'src/config/repositoryEntry.ts',
  'src/dialog/eligibility.ts',
  'src/extensions/architect/architectInboxDecision.ts',
  'src/extensions/architect/ask/askDecision.ts',
  'src/extensions/architect/ask/askIntakeDecision.ts',
  'src/extensions/architect/ask/gateQuestion.ts',
  'src/extensions/architect/claimRelease/claimReleaseDecision.ts',
  'src/extensions/architect/claimRelease/launchOutcomeDecision.ts',
  'src/extensions/architect/endNoteDecision.ts',
  'src/extensions/architect/finalHandoverDecision.ts',
  'src/extensions/architect/gateDecision.ts',
  'src/extensions/architect/handoffDecision.ts',
  'src/extensions/architect/open/openReuseDecision.ts',
  'src/extensions/architect/queuedHandover.ts',
  'src/extensions/architect/readFailureDecision.ts',
  'src/extensions/architect/shutdownDecision.ts',
  'src/extensions/architect/startFence/startFenceDecision.ts',
  'src/extensions/architect/startTicket/startTicketDecision.ts',
  'src/extensions/askUserQuestion/layout.ts',
  'src/extensions/askUserQuestion/questionnaire.ts',
  'src/extensions/askUserQuestion/typedAnswerGuard.ts',
  'src/extensions/askUserQuestion/validation.ts',
  'src/extensions/bashGuard/detachedOutputDecision.ts',
  'src/extensions/checkoutWarning/message.ts',
  'src/extensions/commit/autosquash.ts',
  'src/extensions/commit/fileRequests.ts',
  'src/extensions/compaction/reminder.ts',
  'src/extensions/draftReview/reviewDecisions.ts',
  'src/extensions/fullCheck/idleDecision.ts',
  'src/extensions/fullCheck/mutationVerdict.ts',
  'src/extensions/handBack/handBackDecision.ts',
  'src/extensions/handover/placement.ts',
  'src/extensions/handoverQuestion/answer/answerDecision.ts',
  'src/extensions/handoverQuestion/answer/receivedQuestion.ts',
  'src/extensions/handoverQuestion/senderMessages.ts',
  'src/extensions/improvement/recordPassDecision.ts',
  'src/extensions/improvement/recordRequest.ts',
  'src/extensions/inbox/arrivalDecision.ts',
  'src/extensions/inbox/guardDecision.ts',
  'src/extensions/inbox/ownerDecision.ts',
  'src/extensions/mergeWatch/autoMergeRequest.ts',
  'src/extensions/mergeWatch/mergeOffer.ts',
  'src/extensions/mergeWatch/watchOutcome.ts',
  'src/extensions/mergeWatch/watchStart.ts',
  'src/extensions/modelFallback/fallbackRoute.ts',
  'src/extensions/piResume/sessionDecision.ts',
  'src/extensions/plan/headerLayout.ts',
  'src/extensions/plan/prompt.ts',
  'src/extensions/plan/stepStyle.ts',
  'src/extensions/plan/steps.ts',
  'src/extensions/pr/evidenceDecisions.ts',
  'src/extensions/pr/publish/publishDecisions.ts',
  'src/extensions/pr/reuseDecisions.ts',
  'src/extensions/pr/targetDecisions.ts',
  'src/extensions/pr/verifyDecisions.ts',
  'src/extensions/prFeedback/checkEvidence.ts',
  'src/extensions/prFeedback/feedbackBounds.ts',
  'src/extensions/prFeedback/snapshotChange.ts',
  'src/extensions/prFeedback/statusDecisions.ts',
  'src/extensions/prFeedback/threads.ts',
  'src/extensions/prFeedback/writes.ts',
  'src/extensions/sessionLock/lockDecision.ts',
  'src/extensions/slice/blockers.ts',
  'src/extensions/slice/foreignWrites.ts',
  'src/extensions/slice/startDecisions.ts',
  'src/extensions/slice/startPickDecisions.ts',
  'src/extensions/slice/writes.ts',
  'src/extensions/snippets/history.ts',
  'src/extensions/snippets/insertion.ts',
  'src/extensions/snippets/query.ts',
  'src/extensions/stack/branchDecisions.ts',
  'src/extensions/stack/chainDecisions.ts',
  'src/extensions/stack/checkDecisions.ts',
  'src/extensions/stack/historyDecisions.ts',
  'src/extensions/stack/linkDecisions.ts',
  'src/extensions/stack/readResult.ts',
  'src/extensions/statusbar/reuseDecision.ts',
  'src/extensions/subagents/acceptanceRefusal.ts',
  'src/extensions/subagents/bashOutputCap.ts',
  'src/extensions/subagents/capacityRefusal.ts',
  'src/extensions/subagents/deadlineDecision.ts',
  'src/extensions/subagents/eventDecision.ts',
  'src/extensions/subagents/fullCheckRefusal.ts',
  'src/extensions/subagents/incompleteReport.ts',
  'src/extensions/subagents/launchEnvironment.ts',
  'src/extensions/subagents/modelRefusal.ts',
  'src/extensions/subagents/qaBrief.ts',
  'src/extensions/subagents/report/pageInventory/pageInventory.ts',
  'src/extensions/subagents/report/pageInventory/pageInventoryDecision.ts',
  'src/extensions/subagents/report/pageInventory/pageInventoryDecisions.ts',
  'src/extensions/subagents/report/pageInventory/pageInventoryRefusal.ts',
  'src/extensions/subagents/report/reportGateDecision.ts',
  'src/extensions/subagents/report/reportSections.ts',
  'src/extensions/subagents/roleLaunchRefusal.ts',
  'src/extensions/subagents/sessionUse.ts',
  'src/extensions/subagents/skillToolsRefusal.ts',
  'src/extensions/subagents/summaryLength.ts',
  'src/extensions/subagents/workerAnswer.ts',
  'src/extensions/subagents/workerDecision.ts',
  'src/extensions/subagents/workerFolderDecision.ts',
  'src/extensions/subagents/workerMessage.ts',
  'src/extensions/subagents/workerModels.ts',
  'src/extensions/subagents/workerName.ts',
  'src/extensions/subagents/workerPackages.ts',
  'src/extensions/subagents/workerPlacement.ts',
  'src/extensions/subagents/workerResume.ts',
  'src/extensions/subagents/workerStart.ts',
  'src/extensions/subagents/workerTools.ts',
  'src/extensions/tauSkills/requiredFor.ts',
  'src/extensions/tdd/configLayers.ts',
  'src/extensions/tdd/fileRoles.ts',
  'src/extensions/tdd/inputGlob.ts',
  'src/extensions/tdd/observationTransition.ts',
  'src/extensions/tdd/projectPath.ts',
  'src/extensions/tdd/repositoryRoot.ts',
  'src/extensions/tdd/runner/cargoInputFiles.ts',
  'src/extensions/tdd/runner/cargoMetadata.ts',
  'src/extensions/tdd/runner/constants.ts',
  'src/extensions/tdd/runner/junit.ts',
  'src/extensions/tdd/runner/nextestArguments.ts',
  'src/extensions/tdd/runner/nextestFocus.ts',
  'src/extensions/tdd/runner/nextestList.ts',
  'src/extensions/tdd/runner/nextestResult.ts',
  'src/extensions/tdd/runner/report.ts',
  'src/extensions/tdd/runner/rustAttribution.ts',
  'src/extensions/tdd/runner/rustDepInfo.ts',
  'src/extensions/tdd/runner/testNames.ts',
  'src/extensions/tdd/runner/vitestOptions.ts',
  'src/extensions/tdd/runner/vitestSelection.ts',
  'src/extensions/tdd/runner/vitestVersion.ts',
  'src/extensions/tdd/worktreePath.ts',
  'src/extensions/toolResultRedaction/redaction.ts',
  'src/extensions/tracker/approvedPreview.ts',
  'src/extensions/tracker/cancelDecision.ts',
  'src/extensions/tracker/candidateFit.ts',
  'src/extensions/tracker/commentTarget.ts',
  'src/extensions/tracker/promptLines.ts',
  'src/extensions/tracker/setupDiagnostic.ts',
  'src/extensions/tracker/ticketWrites.ts',
  'src/extensions/verification/itemDecision.ts',
  'src/extensions/verification/runDecision.ts',
  'src/fileLock/lockHolderDecision.ts',
  'src/github/pullRequestDecisions.ts',
  'src/github/repositoryTargetDecisions.ts',
  'src/handoverSender.ts',
  'src/improvement/classIdentity.ts',
  'src/improvement/correctDecision.ts',
  'src/improvement/historyRead.ts',
  'src/improvement/sessionDirectory.ts',
  'src/improvement/signals.ts',
  'src/improvement/statusDecision.ts',
  'src/improvement/sweepDecision.ts',
  'src/improvement/taskFacts.ts',
  'src/improvement/taskMapping.ts',
  'src/improvement/transcript.ts',
  'src/improvement/workerRecord.ts',
  'src/improvement/writeDecision.ts',
  'src/inbox/protocol.ts',
  'src/inbox/receiptDecision.ts',
  'src/inbox/targetDecision.ts',
  'src/instructions/guideLinks.ts',
  'src/instructions/languageRules/languageRulesDecision.ts',
  'src/instructions/markdownLinks.ts',
  'src/instructions/stommeGuides/stommeGuidesDecision.ts',
  'src/instructions/syncRecord.ts',
  'src/linear/descriptionMatch.ts',
  'src/linear/ownership.ts',
  'src/piStart/startedModel/startedModel.ts',
  'src/process/stateDecision.ts',
  'src/prose.ts',
  'src/questionGate/decideDecision.ts',
  'src/questionGate/decision/decision.ts',
  'src/questionGate/examples.ts',
  'src/questionGate/panelVerdict.ts',
  'src/questionGate/shadowDecision.ts',
  'src/reviewBots/reviewBotDecisions.ts',
  'src/reviewCapture/chainSelectionDecision.ts',
  'src/reviewCapture/coverageDecision.ts',
  'src/reviewCapture/endpointDecision.ts',
  'src/reviewCapture/endpointPruneDecision.ts',
  'src/reviewCapture/evidenceDecisions.ts',
  'src/reviewCapture/fixScope.ts',
  'src/reviewCapture/freshness.ts',
  'src/reviewCapture/generationDecision.ts',
  'src/reviewCapture/gitQuotedName.ts',
  'src/reviewCapture/lineEndingWarning.ts',
  'src/reviewCapture/ownershipDecision.ts',
  'src/reviewCapture/patchBlobs.ts',
  'src/reviewCapture/predecessorDecision.ts',
  'src/reviewCapture/reports.ts',
  'src/role/roleGuidelines.ts',
  'src/role/roleTools.ts',
  'src/schema.ts',
  'src/sessionMessage/askResult.ts',
  'src/sessionMessage/sessionMessage.ts',
  'src/shell.ts',
  'src/tabName.ts',
  'src/terminalText.ts',
  'src/verification/freshness.ts',
  'src/verification/selection.ts',
  'src/wake/deliveryStep.ts',
  'tests/hcIsolationHarness.ts',
];

const pureAdvice =
  'A pure module must not read records, the clock, randomness, or the environment, or escape a function into an imported, parameter, or global object. Move the read or effect to the caller and pass the value in as a fact.';

// `strictToolRegistration` replaces `registerTool` on the API it is given and keeps a set of
// installed APIs, so `src/schema.ts` breaks the no-effect rule. The import table may only shrink,
// so a new module is not an option. Record the finding instead of dropping the module from the
// registry.
const pureModuleExceptions: Readonly<Record<string, string>> = {
  'src/schema.ts': 'assigns a function to a property',
};

const effectMembers = new Set(['Date.now', 'Math.random', 'performance.now', 'process.env']);

// Reads `Date.now` and `Date['now']` alike.
const propertyKey = ({ computed, property }: MemberExpression) => {
  if (property.type === 'Identifier' && !computed) {
    return property.name;
  }

  if (property.type === 'TemplateLiteral' && property.expressions.length === 0) {
    return property.quasis[0]?.value.cooked ?? undefined;
  }

  return property.type === 'Literal' && typeof property.value === 'string'
    ? property.value
    : undefined;
};

const memberName = (node: MemberExpression) => {
  const key = propertyKey(node);

  return node.object.type === 'Identifier' && key !== undefined
    ? `${node.object.name}.${key}`
    : undefined;
};

// Inline `{ type X }` specifiers still load the module under verbatimModuleSyntax, so only a
// top-level `import type` or `export type` is type-only.
const isTypeOnly = (node: ModuleDeclaration) => {
  const typeImport = 'importKind' in node && node.importKind === 'type';
  const typeExport = 'exportKind' in node && node.exportKind === 'type';

  return typeImport || typeExport;
};

const findingLines = (found: string[]) => found.map((finding) => Number(finding.split(':')[1]));

// The outside libraries a registered module may import, by module path.
const pureLibraries: Readonly<Record<string, readonly string[]>> = {
  'scripts/questionGateScore/questionGateScorePrepare.ts': ['node:crypto'],
  'src/extensions/modelFallback/fallbackRoute.ts': ['typebox', 'typebox/value'],
  'src/extensions/plan/steps.ts': ['typebox', 'typebox/value'],
  'src/extensions/pr/publish/publishDecisions.ts': ['node:crypto'],
  'src/extensions/improvement/recordRequest.ts': ['node:path', 'typebox'],
  'src/extensions/subagents/report/pageInventory/pageInventoryDecision.ts': ['marked'],
  'src/extensions/subagents/report/pageInventory/pageInventoryDecisions.ts': ['marked'],
  'src/extensions/subagents/report/reportSections.ts': ['marked'],
  'src/extensions/tdd/inputGlob.ts': ['minimatch'],
  'src/extensions/tdd/projectPath.ts': ['node:path'],
  'src/extensions/tdd/runner/cargoInputFiles.ts': ['node:path'],
  'src/extensions/tdd/runner/junit.ts': ['@xmldom/xmldom'],
  'src/extensions/tdd/runner/report.ts': ['node:path'],
  'src/extensions/handBack/handBackDecision.ts': ['marked'],
  'src/improvement/classIdentity.ts': ['node:crypto'],
  'src/improvement/historyRead.ts': ['typebox', 'typebox/value'],
  'src/improvement/sessionDirectory.ts': ['node:path'],
  'src/improvement/taskFacts.ts': ['node:path'],
  'src/improvement/taskMapping.ts': ['node:path'],
  'src/improvement/transcript.ts': ['typebox'],
  'src/improvement/writeDecision.ts': ['node:path'],
  'src/inbox/protocol.ts': ['typebox', 'typebox/value'],
  'src/instructions/guideLinks.ts': ['node:path'],
  'src/instructions/markdownLinks.ts': ['entities', 'github-slugger', 'marked'],
  'src/instructions/stommeGuides/stommeGuidesDecision.ts': ['node:path', 'smol-toml'],
  'src/instructions/syncRecord.ts': ['smol-toml'],
  'src/prose.ts': ['marked'],
  'src/schema.ts': ['typebox', 'typebox/value'],
  'src/terminalText.ts': ['node:util'],
  'tests/hcIsolationHarness.ts': ['node:path'],
};

const isPureLibrary = (path: string, specifier: string) =>
  pureLibraries[path]?.includes(specifier) ?? false;

const bindingNames = (
  pattern: BindingPattern | BindingRestElement | ParamPattern | TSParameterProperty,
): string[] => {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        property.type === 'RestElement'
          ? bindingNames(property.argument)
          : bindingNames(property.value),
      );
    case 'ArrayPattern':
      return pattern.elements.flatMap((element) => (element === null ? [] : bindingNames(element)));
    case 'AssignmentPattern':
      return bindingNames(pattern.left);
    case 'RestElement':
      return bindingNames(pattern.argument);
    case 'TSParameterProperty':
      return bindingNames(pattern.parameter);
    default:
      return [];
  }
};

const importedBindings = (program: Program): Set<string> =>
  new Set(
    program.body.flatMap((node) => {
      if (node.type !== 'ImportDeclaration') {
        return [];
      }

      return node.specifiers.map((specifier) => specifier.local.name);
    }),
  );

const createBindingScopes = () => {
  const scopes: BindingScope[] = [{ bindings: new Map(), functionScope: true }];

  const declare = (name: string, kind: BindingKind): void => {
    scopes.at(-1)?.bindings.set(name, kind);
  };

  // A `var` belongs to the nearest function, not to the block that declares it.
  const declareVariable = (name: string, kind: BindingKind): void => {
    const scope = scopes.findLast((candidate) => candidate.functionScope);

    scope?.bindings.set(name, kind);
  };

  const enter = (functionScope: boolean): void => {
    scopes.push({ bindings: new Map(), functionScope });
  };

  const exit = (): void => {
    scopes.pop();
  };

  // The innermost binding wins, so a local that shadows an import or a parameter does not escape.
  const kindOf = (name: string): BindingKind | undefined => {
    for (const scope of scopes.toReversed()) {
      const kind = scope.bindings.get(name);

      if (kind !== undefined) {
        return kind;
      }
    }

    return undefined;
  };

  return { declare, declareVariable, enter, exit, kindOf };
};

type BindingScopes = ReturnType<typeof createBindingScopes>;

// A function declaration is hoisted to the top of its scope, so a later assignment still sees it.
const functionNames = (statements: readonly Statement[]): string[] =>
  statements.flatMap((statement) => {
    const isExport =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration';

    const declaration = isExport ? statement.declaration : statement;

    return declaration?.type === 'FunctionDeclaration' && declaration.id !== null
      ? [declaration.id.name]
      : [];
  });

const declareFunctions = (bindings: BindingScopes, statements: readonly Statement[]): void => {
  for (const name of functionNames(statements)) {
    bindings.declare(name, 'function');
  }
};

// A class declaration is not hoisted, so it binds its name only after the declaration.
const declareClass = (bindings: BindingScopes, node: Class): void => {
  if (node.id !== null) {
    bindings.declare(node.id.name, 'function');
  }
};

const globalObjects = new Set(['global', 'globalThis', 'process', 'self', 'window']);

const rootName = (node: Expression): string | undefined => {
  if (node.type === 'Identifier') {
    return node.name;
  }

  return node.type === 'MemberExpression' ? rootName(node.object) : undefined;
};

const isEscapingObject = (bindings: BindingScopes, node: MemberExpression): boolean => {
  const name = rootName(node.object);

  if (name === undefined) {
    return false;
  }

  const kind = bindings.kindOf(name);
  const isGlobal = kind === undefined && globalObjects.has(name);

  return kind === 'escaping' || isGlobal;
};

const isFunctionValue = (bindings: BindingScopes, node: Expression | null): boolean => {
  if (node === null) {
    return false;
  }

  if (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ClassExpression'
  ) {
    return true;
  }

  return node.type === 'Identifier' && bindings.kindOf(node.name) === 'function';
};

// A plain identifier initializer carries its binding's kind, so an alias of an imported or parameter
// object still escapes when a property of the alias is assigned.
const aliasKind = (bindings: BindingScopes, node: Expression | null): BindingKind => {
  if (isFunctionValue(bindings, node)) {
    return 'function';
  }

  const isEscapingAlias = node?.type === 'Identifier' && bindings.kindOf(node.name) === 'escaping';

  return isEscapingAlias ? 'escaping' : 'local';
};

const enterFunctionScope = (
  bindings: BindingScopes,
  node: Function | ArrowFunctionExpression,
): void => {
  bindings.enter(true);

  for (const name of node.params.flatMap(bindingNames)) {
    bindings.declare(name, 'escaping');
  }
};

const enterBlockScope = (bindings: BindingScopes, node: BlockStatement): void => {
  bindings.enter(false);
  declareFunctions(bindings, node.body);
};

const declareVariables = (bindings: BindingScopes, node: VariableDeclaration): void => {
  const declareName = node.kind === 'var' ? bindings.declareVariable : bindings.declare;

  for (const declarator of node.declarations) {
    // A pattern binds properties of the initializer, such as a number from a function's `length`.
    const kind =
      declarator.id.type === 'Identifier' ? aliasKind(bindings, declarator.init) : 'local';

    for (const name of bindingNames(declarator.id)) {
      declareName(name, kind);
    }
  }
};

const checkImport = (
  path: string,
  registry: readonly string[],
  node: ModuleDeclaration,
  at: (offset: number, what: string) => void,
): void => {
  const specifier = 'source' in node ? node.source?.value : undefined;

  if (specifier === undefined || isTypeOnly(node)) {
    return;
  }

  const target = posix.join(posix.dirname(path), specifier).replace(/\.js$/, '.ts');

  if (isPureLibrary(path, specifier)) {
    return;
  }

  if (!specifier.startsWith('.') || !registry.includes(target)) {
    at(node.start, `runtime import of ${specifier}`);
  }
};

// `Date()` returns the current time as a string.
const callProblem = (node: CallExpression): string | undefined => {
  const callee = node.callee.type === 'Identifier' ? node.callee.name : undefined;

  return callee === 'require' || callee === 'Date' ? `${callee}()` : undefined;
};

const isCurrentDate = (node: NewExpression): boolean =>
  node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0;

const effectVisitors = (
  bindings: BindingScopes,
  at: (offset: number, what: string) => void,
): VisitorObject => ({
  AssignmentExpression: (node) => {
    // A function assigned to a property of a parameter, an imported binding, or a global escapes
    // the module, so the rule counts it as an effect.
    const escapes = node.left.type === 'MemberExpression' && isEscapingObject(bindings, node.left);

    if (escapes && isFunctionValue(bindings, node.right)) {
      at(node.start, 'assigns a function to a property');
    }
  },
  CallExpression: (node) => {
    const problem = callProblem(node);

    if (problem !== undefined) {
      at(node.start, problem);
    }
  },
  NewExpression: (node) => {
    if (isCurrentDate(node)) {
      at(node.start, 'new Date()');
    }
  },
  MemberExpression: (node) => {
    const name = memberName(node);

    if (name !== undefined && effectMembers.has(name)) {
      at(node.start, name);
    }
  },
});

// Lists each runtime import outside the registry, dynamic load, and effect in a registered module.
const impurities = (path: string, source: string, registry: readonly string[]) => {
  const found: string[] = [];
  const program = parseSync(path, source).program;
  const bindings = createBindingScopes();

  const at = (offset: number, what: string) => {
    const lineNumber = source.slice(0, offset).split('\n').length;

    return found.push(`${path}:${lineNumber}: ${what}`);
  };

  for (const name of importedBindings(program)) {
    bindings.declare(name, 'escaping');
  }

  declareFunctions(bindings, program.body);

  new Visitor({
    FunctionDeclaration: (node) => {
      enterFunctionScope(bindings, node);
    },
    'FunctionDeclaration:exit': bindings.exit,
    FunctionExpression: (node) => {
      enterFunctionScope(bindings, node);
    },
    'FunctionExpression:exit': bindings.exit,
    TSDeclareFunction: (node) => {
      enterFunctionScope(bindings, node);
    },
    'TSDeclareFunction:exit': bindings.exit,
    TSEmptyBodyFunctionExpression: (node) => {
      enterFunctionScope(bindings, node);
    },
    'TSEmptyBodyFunctionExpression:exit': bindings.exit,
    ArrowFunctionExpression: (node) => {
      enterFunctionScope(bindings, node);
    },
    'ArrowFunctionExpression:exit': bindings.exit,
    BlockStatement: (node) => {
      enterBlockScope(bindings, node);
    },
    'BlockStatement:exit': bindings.exit,
    VariableDeclaration: (node) => {
      declareVariables(bindings, node);
    },
    ClassDeclaration: (node) => {
      declareClass(bindings, node);
    },
    ImportDeclaration: (node) => {
      checkImport(path, registry, node, at);
    },
    ExportNamedDeclaration: (node) => {
      checkImport(path, registry, node, at);
    },
    ExportAllDeclaration: (node) => {
      checkImport(path, registry, node, at);
    },
    ImportExpression: (node) => at(node.start, 'dynamic import'),
    ...effectVisitors(bindings, at),
  }).visit(program);

  return found;
};

const environmentAccess = (node: Expression) =>
  node.type === 'MemberExpression' && memberName(node) === 'process.env';

// Lists the variables a source reads from process.env. Writes, deletes, and text are not reads.
const environmentReads = (path: string, source: string) => {
  const found: string[] = [];
  const notReads = new Set<unknown>();

  new Visitor({
    AssignmentExpression: (node) => {
      if (node.operator === '=') {
        notReads.add(node.left);
      }
    },
    UnaryExpression: (node) => {
      if (node.operator === 'delete') {
        notReads.add(node.argument);
      }
    },
    MemberExpression: (node) => {
      const name = propertyKey(node);

      if (environmentAccess(node.object) && name !== undefined && !notReads.has(node)) {
        found.push(name);
      }
    },
    BinaryExpression: (node) => {
      const { left } = node;

      if (node.operator === 'in' && left.type === 'Literal' && environmentAccess(node.right)) {
        found.push(String(left.value));
      }
    },
  }).visit(parseSync(path, source).program);

  return found;
};

// Folders that group files under src/ without forming a module.
const groupingFolders = new Set(['src', 'src/extensions', 'src/skills']);

const isTypeScriptFile = (path: string) => path.endsWith('.ts') && !path.endsWith('.d.ts');

const isProductionSource = (path: string) =>
  isTypeScriptFile(path) && !isTest(path) && !isFixture(path);

const parentFolders = (path: string) =>
  path
    .split('/')
    .slice(0, -1)
    .map((_, index, segments) => segments.slice(0, index + 1).join('/'));

// The module folder a file belongs to: src/<module>/ or src/extensions/<module>/.
const moduleFolderOf = (path: string) => {
  const depth = path.startsWith('src/extensions/') ? 3 : 2;
  const segments = path.split('/');
  const folder = segments.slice(0, depth).join('/');

  return segments.length > depth && !groupingFolders.has(folder) ? folder : undefined;
};

const isStommeSource = (path: string) =>
  /\.tsx?$/.test(path) && !path.endsWith('.d.ts') && !isFixture(path);

const layoutProblems = (paths: readonly string[]) => {
  const sources = paths.filter(isProductionSource);

  const indexFiles = paths
    .filter((path) => basename(path).startsWith('index.') && !isStommeSource(path))
    .map((path) => `${path}: index file`);

  const folders = [...new Set(paths.flatMap(parentFolders))].filter(
    (folder) => !groupingFolders.has(folder),
  );

  const oneFileFolders = folders
    .filter((folder) => sources.filter((path) => path.startsWith(`${folder}/`)).length === 1)
    .map((folder) => `${folder}/: one production source file`);

  const modules = [...new Set(sources.flatMap((path) => moduleFolderOf(path) ?? []))];

  const missingEntries = modules
    .filter((folder) => !sources.includes(`${folder}/${basename(folder)}.ts`))
    .map((folder) => `${folder}/: no entry file ${basename(folder)}.ts`);

  return [...indexFiles, ...oneFileFolders, ...missingEntries];
};

const layoutAdvice =
  'Keep source folders free of index files, name a folder module entry after its folder, and keep a module with one production source file as a flat file beside its siblings.';

it('keeps fixtures out of production modules', () => {
  const importers = sourceFiles
    .filter((path) => !isTest(path) && !isFixture(path))
    .filter((path) => fixtureLoad.test(readFileSync(join(root, path), 'utf8')));

  expect(importers).toEqual([]);
});

const purityProblems = (
  modules: readonly string[],
  exceptions: Readonly<Record<string, string>>,
  readSource: (path: string) => string,
): string[] => {
  const problems = modules.flatMap((path) => {
    const findings = impurities(path, readSource(path), modules);
    const exception = exceptions[path];

    if (exception === undefined) {
      return findings;
    }

    const suppressed = findings.findIndex((finding) => finding.endsWith(`: ${exception}`));

    if (suppressed === -1) {
      return [...findings, `${path}: unused exception ${exception}`];
    }

    return findings.filter((_finding, index) => index !== suppressed);
  });

  const unregistered = Object.keys(exceptions)
    .filter((path) => !modules.includes(path))
    .map((path) => `${path}: exception for an unregistered module`);

  return [...problems, ...unregistered];
};

it('keeps registered pure modules free of reads and effects', () => {
  const found = purityProblems(pureModules, pureModuleExceptions, (path) =>
    readFileSync(join(root, path), 'utf8'),
  );

  expect(found, pureAdvice).toEqual([]);
});

const readImportSource = (): string => "import { readFile } from 'node:fs/promises';\n";

const readImportAndDateSource = (): string =>
  `${readImportSource()}const first = Date();\nconst second = Date();\n`;

const testRegistry = ['src/pure/decide.ts', 'src/pure/rules.ts'];

const functionPropertySource = (): string =>
  'const install = (api) => {\n  api.run = () => 1;\n};\n';

const aliasedFunctionPropertySource = (): string =>
  'const wrapper = () => 1;\nconst install = (api) => {\n  api.run = wrapper;\n};\n';

const classPropertySource = (): string => 'const install = (api) => {\n  api.run = class {};\n};\n';

const aliasedClassPropertySource = (): string =>
  'const handler = class {};\nconst install = (api) => {\n  api.run = handler;\n};\n';

const classDeclarationPropertySource = (): string =>
  'class Handler {}\nconst install = (api) => {\n  api.run = Handler;\n};\n';

const endedBlockClassSource = (): string =>
  'const install = (api) => {\n  {\n    class Handler {}\n    Handler;\n  }\n  api.run = Handler;\n};\n';

const lateClassSource = (): string =>
  'const install = (api) => {\n  api.run = Handler;\n};\nclass Handler {}\n';

const importedFunctionPropertySource = (): string =>
  "import { api } from './rules.js';\napi.run = () => 1;\n";

const importedAliasPropertySource = (): string =>
  "import { api } from './rules.js';\nconst target = api;\ntarget.run = () => 1;\n";

const importedNestedFunctionPropertySource = (): string =>
  "import { api } from './rules.js';\napi.config.run = () => 1;\n";

const globalFunctionPropertySource = (): string =>
  'globalThis.install = () => 1;\nwindow.handler = () => 1;\nglobal.install = () => 1;\nprocess.handler = () => 1;\nself.install = () => 1;\n';

const localFunctionPropertySource = (): string =>
  'const handlers = {};\nhandlers.run = () => "";\n';

const shadowingImportSource = (): string =>
  "import { api } from './rules.js';\nexport const make = () => {\n  const api = {};\n  api.run = () => 1;\n  return api;\n};\n";

const shadowingParameterSource = (): string =>
  'export const install = (api) => {\n  {\n    const api = {};\n    api.run = () => 1;\n  }\n};\n';

const destructuredFunctionSource = (): string =>
  'const helper = () => 1;\nexport const read = (api) => {\n  const { length } = helper;\n  api.run = length;\n};\n';

const hoistedVarFunctionSource = (): string =>
  'export const install = (api) => {\n  if (api) {\n    var later = () => 1;\n  }\n  api.run = later;\n};\n';

const hoistedFunctionPropertySource = (): string =>
  'export const install = (api) => {\n  api.run = later;\n};\nfunction later() {}\n';

const endedBlockFunctionSource = (): string =>
  'export const install = (api) => {\n  if (api) {\n    function later() {}\n    later();\n  }\n  api.run = later;\n};\n';

const siblingFunctionSource = (): string =>
  'const first = (api) => api;\nconst second = () => {\n  const api = {};\n  api.run = () => 1;\n  return api;\n};\n';

const siblingBindingSource = (): string =>
  'const first = () => {\n  const later = () => 1;\n  return later;\n};\nconst second = (api) => {\n  api.run = later;\n};\n';

it('reports a function assigned to a property of a parameter or an imported binding', () => {
  expect(impurities('src/pure/decide.ts', functionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', aliasedFunctionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', importedFunctionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', importedAliasPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);
});

it('reports a class assigned to a property of a parameter', () => {
  expect(impurities('src/pure/decide.ts', classPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', aliasedClassPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);
});

it('reports a class declaration assigned to a property of a parameter', () => {
  expect(impurities('src/pure/decide.ts', classDeclarationPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);
});

it('does not report a class declaration that has not run or has left its block', () => {
  expect(impurities('src/pure/decide.ts', endedBlockClassSource(), testRegistry)).toEqual([]);
  expect(impurities('src/pure/decide.ts', lateClassSource(), testRegistry)).toEqual([]);
});

it('reports a function assigned to a property of a global or of a nested member chain', () => {
  expect(impurities('src/pure/decide.ts', globalFunctionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:1: assigns a function to a property',
    'src/pure/decide.ts:2: assigns a function to a property',
    'src/pure/decide.ts:3: assigns a function to a property',
    'src/pure/decide.ts:4: assigns a function to a property',
    'src/pure/decide.ts:5: assigns a function to a property',
  ]);

  expect(
    impurities('src/pure/decide.ts', importedNestedFunctionPropertySource(), testRegistry),
  ).toEqual(['src/pure/decide.ts:2: assigns a function to a property']);
});

it('does not report a function assigned to a property of a local object', () => {
  expect(impurities('src/pure/decide.ts', localFunctionPropertySource(), testRegistry)).toEqual([]);
});

it('does not report a local that shadows an import', () => {
  expect(impurities('src/pure/decide.ts', shadowingImportSource(), testRegistry)).toEqual([]);
});

it('does not report a local that shadows a parameter', () => {
  expect(impurities('src/pure/decide.ts', shadowingParameterSource(), testRegistry)).toEqual([]);
});

it('does not report a destructured binding as a function', () => {
  expect(impurities('src/pure/decide.ts', destructuredFunctionSource(), testRegistry)).toEqual([]);
});

it('reports a function assigned to a var hoisted out of a block', () => {
  expect(impurities('src/pure/decide.ts', hoistedVarFunctionSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:5: assigns a function to a property',
  ]);
});

it('reports a function assigned before its hoisted declaration', () => {
  expect(impurities('src/pure/decide.ts', hoistedFunctionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);
});

it('does not report a function declared in a block that has ended', () => {
  expect(impurities('src/pure/decide.ts', endedBlockFunctionSource(), testRegistry)).toEqual([]);
});

it('does not let a binding leak out of a sibling function', () => {
  expect(impurities('src/pure/decide.ts', siblingFunctionSource(), testRegistry)).toEqual([]);
  expect(impurities('src/pure/decide.ts', siblingBindingSource(), testRegistry)).toEqual([]);
});

it('applies each pure module exception to one finding and reports a stale exception', () => {
  const modules = ['src/pure/decide.ts'];

  expect(purityProblems(modules, {}, readImportSource)).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
  ]);

  expect(
    purityProblems(
      modules,
      { 'src/pure/decide.ts': 'runtime import of node:fs/promises' },
      readImportSource,
    ),
  ).toEqual([]);

  expect(
    purityProblems(
      modules,
      { 'src/pure/decide.ts': 'assigns a function to a property' },
      readImportSource,
    ),
  ).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/decide.ts: unused exception assigns a function to a property',
  ]);

  expect(
    purityProblems(
      modules,
      { 'src/pure/other.ts': 'runtime import of node:fs/promises' },
      readImportSource,
    ),
  ).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/other.ts: exception for an unregistered module',
  ]);
});

it('keeps the later Date() finding when an exception matches the earlier one', () => {
  expect(
    purityProblems(
      ['src/pure/decide.ts'],
      { 'src/pure/decide.ts': 'Date()' },
      readImportAndDateSource,
    ),
  ).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/decide.ts:3: Date()',
  ]);
});

it('does not let an empty or partial exception reason suppress a finding', () => {
  const modules = ['src/pure/decide.ts'];

  expect(purityProblems(modules, { 'src/pure/decide.ts': '' }, readImportSource)).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/decide.ts: unused exception ',
  ]);

  expect(
    purityProblems(
      modules,
      { 'src/pure/decide.ts': 'a function to a property' },
      functionPropertySource,
    ),
  ).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
    'src/pure/decide.ts: unused exception a function to a property',
  ]);
});

const versionedRecords = [
  {
    writer: 'src/extensions/modelFallback/fallbackRoute.ts',
    fixtures: 'src/extensions/modelFallback/fixtures/routeState',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
  {
    writer: 'src/extensions/plan/steps.ts',
    fixtures: 'src/extensions/plan/fixtures/planRecord',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
  {
    writer: 'src/inbox/store.ts',
    fixtures: 'src/inbox/fixtures/handover',
    names: [
      'previous.json',
      'previousAnswer.json',
      'version2.json',
      'version2Answer.json',
      'version3.json',
      'version3Handover.json',
      'version3Answer.json',
      'current.json',
      'newer.json',
      'malformed.json',
    ],
  },
  {
    writer: 'src/improvement/event.ts',
    fixtures: 'src/improvement/fixtures',
    names: ['event-v1-merge.json', 'event-v2-pass.json', 'event-v2-class.json'],
  },
  {
    writer: 'src/questionGate/record/record.ts',
    fixtures: 'src/questionGate/record/fixtures/record',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
  {
    writer: 'src/questionGate/decision/decisionRecord.ts',
    fixtures: 'src/questionGate/decision/fixtures/decisionRecord',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
  {
    writer: 'src/extensions/handoverQuestion/question/questionRecord.ts',
    fixtures: 'src/extensions/handoverQuestion/question/fixtures/questionRecord',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
];

const recordFormatProblems = ({ writer, fixtures, names }: (typeof versionedRecords)[number]) => {
  const source = readFileSync(join(root, writer), 'utf8');
  const problems: string[] = [];

  if (!/version: Type\.Literal\(/u.test(source)) {
    problems.push(`${writer} has no version literal`);
  }

  for (const name of names) {
    if (!repositoryFiles().includes(`${fixtures}/${name}`)) {
      problems.push(`${fixtures} has no ${name}`);
    }
  }

  return problems;
};

it('gives each versioned record format a version and fixtures', () => {
  expect(versionedRecords.flatMap((format) => recordFormatProblems(format))).toEqual([]);
});

// Lists each entry that sorts before the one above it or repeats it.
const registryOrderProblems = (entries: readonly string[]) =>
  entries.flatMap((entry, index) => {
    const previous = entries[index - 1];

    if (previous === undefined) {
      return [];
    }

    if (entry === previous) {
      return [`duplicate ${entry}`];
    }

    return entry < previous ? [`${entry} sorts before ${previous}`] : [];
  });

it('keeps the pure module registry sorted and free of duplicates', () => {
  expect(registryOrderProblems(pureModules)).toEqual([]);
});

it('keeps the module list and import table sorted, free of duplicates, and closed', () => {
  const names = moduleList.map((module) => module.name);
  const rows = Object.keys(importTable);
  const sharedNames = names.filter((name) => name !== 'tau' && !name.startsWith('extensions/'));

  expect(registryOrderProblems(names)).toEqual([]);
  expect(registryOrderProblems(rows)).toEqual([]);
  expect(rows).toEqual(sharedNames);

  for (const module of moduleList) {
    expect(registryOrderProblems(module.publicFiles), module.name).toEqual([]);
  }

  for (const [row, allowed] of Object.entries(importTable)) {
    expect(registryOrderProblems(allowed), row).toEqual([]);

    expect(
      allowed.filter((name) => !sharedNames.includes(name)),
      row,
    ).toEqual([]);
  }
});

it.each([
  { entries: ['a', 'b', 'c'], problems: [] },
  { entries: ['a', 'c', 'b'], problems: ['b sorts before c'] },
  { entries: ['a', 'b', 'b'], problems: ['duplicate b'] },
])('reports $problems for registry $entries', ({ entries, problems }) => {
  expect(registryOrderProblems(entries)).toEqual(problems);
});

it('refuses reads and effects in a pure module but allows types and other pure modules', () => {
  const registry = ['src/pure/decide.ts', 'src/pure/rules.ts'];

  const allowed = [
    "import type { Task } from '../tasks.js';",
    "import type { Report } from '../records.js';",
    "import { limit } from './rules.js';",
    "export type { Facts } from '../facts.js';",
    'export const decide = (task: Task, report: Report, now: number) =>',
    '  now - task.createdAt > limit && new Date(now).getDay() > 0 && report.outcome;',
  ].join('\n');

  const refused = [
    "import { readReport } from '../records.js';",
    "import { join } from 'node:path';",
    "export { readTask } from '../tasks.js';",
    "export * from './unregistered.js';",
    "import { type Task } from '../tasks.js';",
    "export { type Facts } from '../facts.js';",
    "export const load = () => import('./rules.js');",
    "export const legacy = () => require('./rules.js');",
    'export const now = () => Date.now();',
    "export const nowByKey = () => Date['now']();",
    'export const elapsed = () => performance.now();',
    'export const today = () => new Date();',
    'export const stamp = () => Date();',
    'export const pick = () => Math.random();',
    'export const home = () => process.env.HOME;',
    "export const homeByKey = () => process['env'].HOME;",
    "import { Value } from 'typebox/value';",
    'export const install = (api) => { api.run = () => 1; };',
  ].join('\n');

  const schemaLibrary = "import { Value } from 'typebox/value';";

  expect(impurities('src/pure/decide.ts', allowed, registry)).toEqual([]);

  expect(findingLines(impurities('src/pure/decide.ts', refused, registry))).toEqual(
    Array.from({ length: 18 }, (_, index) => index + 1),
  );

  expect(impurities('src/schema.ts', schemaLibrary, registry)).toEqual([]);
});

it('keeps src/ free of one-file folders and folder modules without an entry', () => {
  const paths = walkRepository('src');

  expect(layoutProblems(paths), layoutAdvice).toEqual([]);
});

it('refuses index files, one-file folders, and missing entries but allows flat files and assets', () => {
  const allowed = [
    'src/tau.ts',
    'src/keys.ts',
    'src/keys.test.ts',
    'src/models/models.ts',
    'src/models/models.test.ts',
    'src/models/allowedModels.ts',
    'src/instructions/writing.md',
    'src/skills/pr/SKILL.md',
    'src/extensions/themes.ts',
    'src/extensions/commit/commit.ts',
    'src/extensions/commit/tool.ts',
    'src/extensions/commit/fixtures/repository.ts',
    'src/extensions/snippets/snippets.ts',
    'src/extensions/snippets/menu.ts',
    'src/extensions/snippets/snippets/verify.md',
    'src/extensions/subagents/subagents.ts',
    'src/extensions/subagents/launch.ts',
    'src/extensions/subagents/profiles/scout.md',
  ];

  const refused = [
    'src/skills/pr/index.md',
    'src/models/index.d.ts',
    'src/errors/errors.ts',
    'src/errors/errors.test.ts',
    'src/extensions/bareRoot/bareRoot.ts',
    'src/extensions/bareRoot/fixtures/fake.ts',
    'src/extensions/tdd/config.ts',
  ];

  expect(layoutProblems(allowed)).toEqual([]);

  expect(layoutProblems(refused)).toEqual([
    'src/skills/pr/index.md: index file',
    'src/models/index.d.ts: index file',
    'src/errors/: one production source file',
    'src/extensions/bareRoot/: one production source file',
    'src/extensions/tdd/: one production source file',
    'src/extensions/tdd/: no entry file tdd.ts',
  ]);
});

it('puts every test file in exactly one Vitest project', () => {
  const testFiles = repositoryFiles().filter((path) => path.endsWith('.test.ts'));

  const projects = (config.test?.projects ?? []) as {
    test: { name: string; include: string[]; exclude: string[] };
  }[];

  const projectsOf = (file: string) =>
    projects
      .map(({ test }) => test)
      .filter(({ include, exclude }) => {
        const included = include.some((pattern) => posix.matchesGlob(file, pattern));
        const excluded = exclude.some((pattern) => posix.matchesGlob(file, pattern));

        return included && !excluded;
      })
      .map(({ name }) => name);

  const misplaced = testFiles
    .map((file) => ({ file, owners: projectsOf(file) }))
    .filter(({ owners }) => owners.length !== 1);

  expect(projects).toHaveLength(10);
  expect(testFiles.length).toBeGreaterThan(100);
  expect(misplaced).toEqual([]);
});

it('handles every environment variable that test code reads in the cached test tasks', () => {
  const isTestCode = (path: string) =>
    isTest(path) || isFixture(path) || /^tests\/[^/]+\.ts$/.test(path);

  const testCode = repositoryFiles().filter((path) => path.endsWith('.ts') && isTestCode(path));

  const handled = new Set([...testEnvironment, ...testManagedEnvironment]);

  const unhandled = testCode.flatMap((file) =>
    environmentReads(file, readFileSync(join(root, file), 'utf8'))
      .filter((name) => !handled.has(name))
      .map(
        (name) =>
          `${file}: reads ${name}, which is not in testEnvironment or testManagedEnvironment`,
      ),
  );

  expect(testCode.length).toBeGreaterThan(100);
  expect(unhandled).toEqual([]);
});

it('counts reads of process.env and ignores writes, deletes, comments, and strings', () => {
  const reads = [
    'export const a = process.env.ONE;',
    "export const b = process.env['TWO'];",
    'export const c = process.env[`THREE`];',
    'export const d = process.env?.FOUR;',
    "export const e = 'FIVE' in process.env;",
    "export const f = process['env'].SIX;",
    'process.env.SEVEN += 1;',
  ].join('\n');

  const ignored = [
    'process.env.EIGHT = "x";',
    "process.env['NINE'] = 'x';",
    'delete process.env.TEN;',
    '// process.env.ELEVEN',
    '/* process.env.TWELVE */',
    "export const text = 'process.env.THIRTEEN';",
    'export const template = `process.env.FOURTEEN`;',
    // oxlint-disable-next-line no-template-curly-in-string -- The probe source holds the placeholder.
    'export const dynamic = process.env[`A${name}`];',
  ].join('\n');

  expect(environmentReads('tests/probe.ts', reads)).toEqual([
    'ONE',
    'TWO',
    'THREE',
    'FOUR',
    'FIVE',
    'SIX',
    'SEVEN',
  ]);

  expect(environmentReads('tests/probe.ts', ignored)).toEqual([]);
});
