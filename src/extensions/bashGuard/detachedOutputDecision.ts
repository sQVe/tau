import { parseShellCommands } from '../../shell/shell.js';
import type { ShellCommand, ShellRedirection } from '../../shell/shell.js';
import { shellNameOf, shellScriptOf } from '../../shell/shellScript.js';
import { detachesProcess, runsRedirectionsOnlyExec } from '../../wrapperAnalysis.js';
import {
  compoundScope,
  enclosingOf,
  innermostGroupOf,
  memberRangeWithFallbackOf,
  pipelineStdout,
} from './detachedScope.js';
import type { CompoundScope } from './detachedScope.js';
import {
  devNull,
  discardsStderr,
  isDescriptor,
  showsStderr,
  streamsOf,
} from './detachedStreams.js';
import type { Streams } from './detachedStreams.js';

export interface DetachedOutputFacts {
  toolName: string;
  command: unknown;
}

interface BlockedDetachedOutput {
  block: true;
  reason: string;
}

export type DetachedOutputDecision = BlockedDetachedOutput | undefined;

// Whether a reader sees a compound's failure, whether a command inside it throws stderr away, and
// whether the command's own redirection does.
type Uninspectable = 'none' | 'unparseable' | 'depth';

interface CompoundFacts {
  readonly shows: boolean;
  readonly discards: boolean;
  readonly ownDiscards: boolean;
  // Why the guard cannot inspect the compound, or `none` when it can.
  readonly uninspectable: Uninspectable;
}

type CompoundFactsOf = (scope: CompoundScope, index: number, depth: number) => CompoundFacts;
type HiddenFailure = 'hidden' | 'unreadable' | 'unparseable' | 'unverifiable';

type CommandScript =
  | { readonly kind: 'none' }
  | { readonly kind: 'script'; readonly script: string }
  | { readonly kind: 'unreadable' };

const maximumDepth = 4;

const noFacts: CompoundFacts = {
  shows: false,
  discards: false,
  ownDiscards: false,
  uninspectable: 'none',
};

const unparseableFacts: CompoundFacts = {
  shows: false,
  discards: false,
  ownDiscards: false,
  uninspectable: 'unparseable',
};

const depthFacts: CompoundFacts = {
  shows: false,
  discards: false,
  ownDiscards: false,
  uninspectable: 'depth',
};

// A compound reports its last command's exit status, so its last member with arguments decides
// whether a reader sees the failure. An earlier member's stderr is not judged, because a detached
// unit that logs its effect may still run a silent step before it. Any member that throws stderr
// away hides one. An empty member set falls back to the streams the compound inherits.
const membersFacts = (
  factsOf: CompoundFactsOf,
  scope: CompoundScope,
  closingIndex: number | undefined,
  depth: number,
): CompoundFacts => {
  const { start, end, fallbackStreams } = memberRangeWithFallbackOf(scope, closingIndex);
  let shows: boolean | undefined;
  let discards = false;
  let uninspectable: Uninspectable = 'none';

  for (let index = start; index < end; index += 1) {
    const member = factsOf(scope, index, depth + 1);
    const hasArguments = (scope.commands[index]?.arguments.length ?? 0) > 0;

    if (hasArguments) {
      shows = member.shows;
    }

    discards ||= member.discards || member.ownDiscards;

    if (uninspectable === 'none') {
      uninspectable = member.uninspectable;
    }
  }

  return {
    shows: shows ?? showsStderr(fallbackStreams),
    discards,
    ownDiscards: false,
    uninspectable,
  };
};

const scriptFacts = (
  factsOf: CompoundFactsOf,
  script: string,
  scriptInherited: Streams,
  depth: number,
): CompoundFacts => {
  const commands = parseShellCommands(script);

  // The parser cannot rule out a hidden failure in a script it does not understand.
  if (commands === undefined) {
    return unparseableFacts;
  }

  const scope = compoundScope(commands, scriptInherited);

  return membersFacts(factsOf, scope, undefined, depth);
};

// A shell reads its script from standard input when a heredoc feeds descriptor 0 and no `-c` word
// names one. The body is the script the shell runs.
const stdinScriptOf = (command: ShellCommand): string | undefined => {
  if (shellNameOf(command.arguments) === undefined) {
    return undefined;
  }

  const readsStdin = command.inputs.some(({ descriptor, kind }) => {
    const namesStdin = descriptor === undefined || descriptor === '0';

    return kind === 'heredoc' && namesStdin;
  });

  return readsStdin ? command.heredocs[0]?.body : undefined;
};

const commandScriptOf = (command: ShellCommand): CommandScript => {
  const shellScript = shellScriptOf(command.arguments);

  if (shellScript.kind === 'unreadable') {
    return { kind: 'unreadable' };
  }

  const script = shellScript.kind === 'script' ? shellScript.script : stdinScriptOf(command);

  return script === undefined ? { kind: 'none' } : { kind: 'script', script };
};

const uninspectableFailure = (kind: Uninspectable): HiddenFailure | undefined => {
  if (kind === 'unparseable') {
    return 'unparseable';
  }

  return kind === 'depth' ? 'unverifiable' : undefined;
};

// A command shows its failure when its own redirections, over the streams it inherits, end stderr in
// a visible file. A compound shows it when its last member with arguments does. A command that
// redirects anything but leaves stderr discarded hides the failure.
//
// Exceeding the budget fails closed: the compound is treated as discarding, because the parser
// cannot rule out a hidden failure. Group nesting consumes the same budget as script nesting.
const compoundFacts = (scope: CompoundScope, index: number, depth: number): CompoundFacts => {
  if (depth > maximumDepth) {
    return depthFacts;
  }

  const command = scope.commands[index];

  if (command === undefined) {
    return noFacts;
  }

  const pipeStdout = pipelineStdout(scope, index);
  const enclosing = enclosingOf(scope, index, pipeStdout);
  const own = streamsOf(command, enclosing);
  const ownDiscards = command.redirections.length > 0 && discardsStderr(own);
  const script = commandScriptOf(command);

  if (script.kind === 'unreadable') {
    return depthFacts;
  }

  if (script.kind === 'script') {
    const nested = scriptFacts(compoundFacts, script.script, own, depth);

    return {
      shows: nested.shows,
      discards: nested.discards,
      ownDiscards,
      uninspectable: nested.uninspectable,
    };
  }

  if (command.group !== undefined) {
    const nestedScope = compoundScope(scope.commands, enclosing, command.group);
    const nested = membersFacts(compoundFacts, nestedScope, index, depth);

    return {
      shows: nested.shows,
      discards: nested.discards,
      ownDiscards,
      uninspectable: nested.uninspectable,
    };
  }

  return { shows: showsStderr(own), discards: false, ownDiscards, uninspectable: 'none' };
};

// A backgrounded group is judged as a whole, so its members are not judged again. A command
// backgrounded inside a foreground group still carries its own hidden failure.
const insideBackgroundedGroup = (commands: readonly ShellCommand[], index: number): boolean =>
  innermostGroupOf(commands, index)?.closing.background === true;

const hidesFailure = (
  scope: CompoundScope,
  index: number,
  depth: number,
  detached: boolean,
): HiddenFailure | undefined => {
  const command = scope.commands[index];

  if (command === undefined) {
    return undefined;
  }

  const detachedCommand = command.background || detached;

  if (!detachedCommand) {
    return undefined;
  }

  const pipeStdout = pipelineStdout(scope, index);
  const own = streamsOf(command, enclosingOf(scope, index, pipeStdout));
  const script = commandScriptOf(command);

  if (script.kind === 'unreadable') {
    return 'unreadable';
  }

  const hasNestedCommand = script.kind === 'script' || command.group !== undefined;

  if (!hasNestedCommand) {
    return showsStderr(own) ? undefined : 'hidden';
  }

  const facts = compoundFacts(scope, index, depth);
  const hidden = !showsStderr(own) && !facts.shows;

  if (facts.discards || hidden) {
    return 'hidden';
  }

  return uninspectableFailure(facts.uninspectable);
};

// A command that only redirects runs no program, so it has no failure to hide unless one of its
// redirections can fail while stderr is discarded.
const redirectionCanFail = (redirection: ShellRedirection): boolean => {
  const { operator, target } = redirection;

  if (operator === '>&' || operator === '<&') {
    return !isDescriptor(target) && target !== devNull;
  }

  if (operator === '<<<') {
    return false;
  }

  return target !== devNull;
};

const someRedirectionCanFail = (command: ShellCommand): boolean =>
  command.redirections.some(redirectionCanFail);

// A command the parser creates at an opening parenthesis has no arguments and closes no group, so
// judging it would read the enclosing redirections as its own. A redirection-only command runs no
// program, so it has no failure to hide unless one of its redirections can fail.
const isJudgedCommand = (command: ShellCommand): boolean => {
  if (runsRedirectionsOnlyExec(command.arguments)) {
    return someRedirectionCanFail(command);
  }

  if (command.group !== undefined || command.arguments.length > 0) {
    return true;
  }

  return someRedirectionCanFail(command);
};

// A foreground command that runs a script still detaches the script's own backgrounded members.
// Past the budget the guard cannot inspect the deeper script, so it reports that it cannot tell.
const nestedScriptFailure = (
  scope: CompoundScope,
  index: number,
  depth: number,
  judge: (scope: CompoundScope, index: number, depth: number) => HiddenFailure | undefined,
): HiddenFailure | undefined => {
  const command = scope.commands[index];

  if (command === undefined) {
    return undefined;
  }

  const script = commandScriptOf(command);

  if (script.kind === 'unreadable') {
    return 'unreadable';
  }

  if (script.kind === 'none') {
    return undefined;
  }

  if (depth > maximumDepth) {
    return 'unverifiable';
  }

  const commands = parseShellCommands(script.script);

  if (commands === undefined) {
    return undefined;
  }

  const inherited = streamsOf(command, enclosingOf(scope, index, pipelineStdout(scope, index)));

  const nested = compoundScope(commands, inherited);

  for (let nestedIndex = 0; nestedIndex < commands.length; nestedIndex += 1) {
    const nestedFailure = judge(nested, nestedIndex, depth + 1);

    if (nestedFailure !== undefined) {
      return nestedFailure;
    }
  }

  return undefined;
};

const judgesHiddenFailure = (
  scope: CompoundScope,
  index: number,
  depth = 0,
): HiddenFailure | undefined => {
  const command = scope.commands[index];

  if (command === undefined || !isJudgedCommand(command)) {
    return undefined;
  }

  if (insideBackgroundedGroup(scope.commands, index)) {
    return undefined;
  }

  const detached = command.background || detachesProcess(command.arguments);
  const hidden = hidesFailure(scope, index, depth, detached);

  if (hidden !== undefined) {
    return hidden;
  }

  if (detached) {
    return undefined;
  }

  return nestedScriptFailure(scope, index, depth, judgesHiddenFailure);
};

export const blockReason =
  'This bash command detaches a process and discards or closes its stderr, so a failure would be hidden. Write the output to a log file, such as `> /tmp/<name>.log 2>&1`, record the command exit status in that log, then read it before reporting the effect.';

export const unverifiableReason =
  'This bash command nests scripts deeper than the guard can inspect, so a hidden failure cannot be ruled out. Run the inner command directly, or write its output to a log file such as `> /tmp/<name>.log 2>&1` and read it before reporting the effect.';

export const unparseableReason =
  'This bash command runs a script the guard cannot parse, so it cannot rule out a hidden failure. Run the inner command directly, or write its output to a log file such as `> /tmp/<name>.log 2>&1` and read it before reporting the effect.';

export const unreadableReason =
  'This bash command has an `env -S` value that depends on the environment, so the guard cannot tell whether it hides a failure. Write the value out in full, or write its output to a log file such as `> /tmp/<name>.log 2>&1` and read it before reporting the effect.';

export const decideDetachedOutput = (facts: DetachedOutputFacts): DetachedOutputDecision => {
  if (facts.toolName !== 'bash' || typeof facts.command !== 'string') {
    return undefined;
  }

  const commands = parseShellCommands(facts.command);

  // The parser rejects only source that bash itself refuses to run, so an unreadable command cannot
  // hide a detached failure. When the parser learns to reject valid syntax, this must fail closed.
  if (commands === undefined) {
    return undefined;
  }

  const scope = compoundScope(commands, new Map());
  let failClosed: HiddenFailure | undefined;

  for (let index = 0; index < commands.length; index += 1) {
    const failure = judgesHiddenFailure(scope, index);

    if (failure === 'hidden') {
      return { block: true, reason: blockReason };
    }

    if (failure !== undefined && failClosed !== 'unreadable') {
      failClosed = failure;
    }
  }

  if (failClosed === undefined || failClosed === 'hidden') {
    return undefined;
  }

  const reasons: Readonly<Record<Exclude<HiddenFailure, 'hidden'>, string>> = {
    unreadable: unreadableReason,
    unparseable: unparseableReason,
    unverifiable: unverifiableReason,
  };

  return { block: true, reason: reasons[failClosed] };
};
