import { parseShellCommands } from '../../shell/shell.js';
import type { ShellCommand, ShellRedirection } from '../../shell/shell.js';
import { shellScriptOf } from '../../shell/shellScript.js';
import { runsRedirectionsOnlyExec } from '../../wrapperAnalysis.js';
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
interface CompoundFacts {
  readonly shows: boolean;
  readonly discards: boolean;
  readonly ownDiscards: boolean;
}

type CompoundFactsOf = (scope: CompoundScope, index: number, depth: number) => CompoundFacts;
type HiddenFailure = 'hidden' | 'unreadable' | 'unverifiable';

const maximumDepth = 4;
const noFacts: CompoundFacts = { shows: false, discards: false, ownDiscards: false };
const failClosedFacts: CompoundFacts = { shows: false, discards: true, ownDiscards: false };

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

  for (let index = start; index < end; index += 1) {
    const member = factsOf(scope, index, depth + 1);
    const hasArguments = (scope.commands[index]?.arguments.length ?? 0) > 0;

    if (hasArguments) {
      shows = member.shows;
    }

    discards ||= member.discards || member.ownDiscards;
  }

  return { shows: shows ?? showsStderr(fallbackStreams), discards, ownDiscards: false };
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
    return failClosedFacts;
  }

  const scope = compoundScope(commands, scriptInherited);

  return membersFacts(factsOf, scope, undefined, depth);
};

// A command shows its failure when its own redirections, over the streams it inherits, end stderr in
// a visible file. A compound shows it when its last member with arguments does. A command that
// redirects anything but leaves stderr discarded hides the failure.
//
// Exceeding the budget fails closed: the compound is treated as discarding, because the parser
// cannot rule out a hidden failure. Group nesting consumes the same budget as script nesting.
const compoundFacts = (scope: CompoundScope, index: number, depth: number): CompoundFacts => {
  if (depth > maximumDepth) {
    return failClosedFacts;
  }

  const command = scope.commands[index];

  if (command === undefined) {
    return noFacts;
  }

  const pipeStdout = pipelineStdout(scope, index);
  const enclosing = enclosingOf(scope, index, pipeStdout);
  const own = streamsOf(command, enclosing);
  const ownDiscards = command.redirections.length > 0 && discardsStderr(own);
  const shellScript = shellScriptOf(command.arguments);

  if (shellScript.kind === 'unreadable') {
    return failClosedFacts;
  }

  if (shellScript.kind === 'script') {
    const nested = scriptFacts(compoundFacts, shellScript.script, own, depth);

    return { shows: nested.shows, discards: nested.discards, ownDiscards };
  }

  if (command.group !== undefined) {
    const nestedScope = compoundScope(scope.commands, enclosing, command.group);
    const nested = membersFacts(compoundFacts, nestedScope, index, depth);

    return { shows: nested.shows, discards: nested.discards, ownDiscards };
  }

  return { shows: showsStderr(own), discards: false, ownDiscards };
};

// A backgrounded group is judged as a whole, so its members are not judged again. A command
// backgrounded inside a foreground group still carries its own hidden failure.
const insideBackgroundedGroup = (commands: readonly ShellCommand[], index: number): boolean =>
  innermostGroupOf(commands, index)?.closing.background === true;

const hidesFailure = (
  scope: CompoundScope,
  index: number,
  depth: number,
): HiddenFailure | undefined => {
  const command = scope.commands[index];

  if (command === undefined || !command.background) {
    return undefined;
  }

  const pipeStdout = pipelineStdout(scope, index);
  const own = streamsOf(command, enclosingOf(scope, index, pipeStdout));
  const shellScript = shellScriptOf(command.arguments);

  if (shellScript.kind === 'unreadable') {
    return 'unreadable';
  }

  if (shellScript.kind === 'script' || command.group !== undefined) {
    const facts = compoundFacts(scope, index, depth);
    const hidden = !showsStderr(own) && !facts.shows;

    return facts.discards || hidden ? 'hidden' : undefined;
  }

  return showsStderr(own) ? undefined : 'hidden';
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

  const shellScript = shellScriptOf(command.arguments);

  if (shellScript.kind === 'unreadable') {
    return 'unreadable';
  }

  if (shellScript.kind === 'none') {
    return undefined;
  }

  if (depth > maximumDepth) {
    return 'unverifiable';
  }

  const commands = parseShellCommands(shellScript.script);

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

  const hidden = hidesFailure(scope, index, depth);

  if (hidden !== undefined) {
    return hidden;
  }

  if (command.background) {
    return undefined;
  }

  return nestedScriptFailure(scope, index, depth, judgesHiddenFailure);
};

export const blockReason =
  'This bash command detaches a process and discards or closes its stderr, so a failure would be hidden. Write the output to a log file, such as `> /tmp/<name>.log 2>&1`, record the command exit status in that log, then read it before reporting the effect.';

export const unverifiableReason =
  'This bash command nests scripts deeper than the guard can inspect, so a hidden failure cannot be ruled out. Run the inner command directly, or write its output to a log file such as `> /tmp/<name>.log 2>&1` and read it before reporting the effect.';

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

    failClosed ??= failure;
  }

  if (failClosed === undefined) {
    return undefined;
  }

  return {
    block: true,
    reason: failClosed === 'unreadable' ? unreadableReason : unverifiableReason,
  };
};
