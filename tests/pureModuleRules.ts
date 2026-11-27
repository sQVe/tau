import { posix } from 'node:path';

import { parseSync, Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  BindingPattern,
  BindingRestElement,
  BlockStatement,
  CallExpression,
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

type BindingKind = 'escaping' | 'function' | 'local';

interface BindingScope {
  bindings: Map<string, BindingKind>;
  functionScope: boolean;
}

interface WrappedExpression {
  readonly expression: Expression;
}

export const pureModules = [
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
  'src/extensions/bashGuard/detachedStreams.ts',
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

export const pureAdvice =
  'A pure module must not read records, the clock, randomness, or the environment, or escape a function into an imported, parameter, or global object. Move the read or effect to the caller and pass the value in as a fact.';

// `strictToolRegistration` replaces `registerTool` on the API it is given and keeps a set of
// installed APIs, so `src/schema.ts` breaks the no-effect rule. The import table may only shrink,
// so a new module is not an option. Record the finding instead of dropping the module from the
// registry.
export const pureModuleExceptions: Readonly<Record<string, string>> = {
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

export const findingLines = (found: string[]): number[] =>
  found.map((finding) => Number(finding.split(':')[1]));

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

  const currentScope = (): BindingScope => {
    const scope = scopes.at(-1);

    if (scope === undefined) {
      throw new Error('the binding scope stack is empty');
    }

    return scope;
  };

  const declare = (name: string, kind: BindingKind): void => {
    currentScope().bindings.set(name, kind);
  };

  // A `var` belongs to the nearest function, not to the block that declares it.
  const declareVariable = (name: string, kind: BindingKind): void => {
    const scope = scopes.findLast((candidate) => candidate.functionScope);

    if (scope === undefined) {
      throw new Error('a var has no enclosing function scope');
    }

    scope.bindings.set(name, kind);
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

// A TypeScript-only wrapper is erased at compile time, so it does not change the value's kind.
const wrapperTypes = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
]);

const isWrappedExpression = (node: Expression): node is Expression & WrappedExpression =>
  wrapperTypes.has(node.type);

const unwrapExpression = (node: Expression): Expression =>
  isWrappedExpression(node) ? unwrapExpression(node.expression) : node;

const isFunctionExpression = (node: Expression | null): boolean => {
  if (node === null) {
    return false;
  }

  const value = unwrapExpression(node);

  return (
    value.type === 'ArrowFunctionExpression' ||
    value.type === 'FunctionExpression' ||
    value.type === 'ClassExpression'
  );
};

// The declaration a statement carries, whether or not it is exported.
const declaredStatement = (statement: Statement) => {
  const isExport =
    statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration';

  return isExport ? statement.declaration : statement;
};

// A function or class declaration is hoisted to the top of its scope for this rule, so a later
// assignment still sees it. The rule is call-agnostic, so it does not model the class TDZ.
const declarationNames = (statements: readonly Statement[]): string[] =>
  statements.flatMap((statement) => {
    const declaration = declaredStatement(statement);

    const isNamedDeclaration =
      declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration';

    if (isNamedDeclaration && declaration.id !== null) {
      return [declaration.id.name];
    }

    return [];
  });

// A function-valued variable is also known at scope entry, so a closure declared before it still
// reports the escape.
const variableFunctionNames = (statements: readonly Statement[]): string[] =>
  statements.flatMap((statement) => {
    const declaration = declaredStatement(statement);

    if (declaration?.type !== 'VariableDeclaration') {
      return [];
    }

    return declaration.declarations.flatMap((declarator) =>
      declarator.id.type === 'Identifier' && isFunctionExpression(declarator.init)
        ? [declarator.id.name]
        : [],
    );
  });

const declareFunctions = (bindings: BindingScopes, statements: readonly Statement[]): void => {
  for (const name of [...declarationNames(statements), ...variableFunctionNames(statements)]) {
    bindings.declare(name, 'function');
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

  if (isFunctionExpression(node)) {
    return true;
  }

  const value = unwrapExpression(node);

  return value.type === 'Identifier' && bindings.kindOf(value.name) === 'function';
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
    // Only an escaping initializer passes its kind on, so `const { api } = request` still escapes.
    const patternKind =
      declarator.init?.type === 'Identifier' && bindings.kindOf(declarator.init.name) === 'escaping'
        ? 'escaping'
        : 'local';

    const kind =
      declarator.id.type === 'Identifier' ? aliasKind(bindings, declarator.init) : patternKind;

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
export const impurities = (path: string, source: string, registry: readonly string[]): string[] => {
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
export const environmentReads = (path: string, source: string): string[] => {
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

export const purityProblems = (
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
