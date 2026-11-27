import { parseShellCommands, runsRedirectionsOnlyExec, shellScriptOf } from '../../shell.js';
import type { ShellCommand, ShellRedirection } from '../../shell.js';
import { devNull, isDescriptor, streamsOf, targetOf, terminal } from './detachedStreams.js';
import type { StreamTarget, Streams } from './detachedStreams.js';

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

interface CompoundScope {
  commands: readonly ShellCommand[];
  inherited: Streams;
  // Members below this index sit inside a group whose redirections `inherited` already includes.
  from: number;
  enclosingByIndex: Map<number, Streams>;
  groups: readonly EnclosingGroup[];
  execs: readonly ExecCommand[];
}

type CompoundFactsOf = (scope: CompoundScope, index: number, depth: number) => CompoundFacts;

interface EnclosingGroup {
  readonly closing: ShellCommand;
  readonly closingIndex: number;
  readonly start: number;
}

interface ExecCommand {
  readonly command: ShellCommand;
  readonly index: number;
  readonly innermost: EnclosingGroup | undefined;
}

type HiddenFailure = 'hidden' | 'unverifiable';

const maximumDepth = 4;
const emptyStreams: Streams = new Map();

// A stream with no redirection reaches the terminal, which is visible.
const showsStderr = (streams: Streams): boolean => {
  const stderr = targetOf(streams, 2);
  const writesVisibleFile = stderr.kind === 'file' && stderr.path !== devNull;

  return stderr.kind === 'terminal' || writesVisibleFile;
};

const discardsStderr = (streams: Streams): boolean => {
  const stderr = targetOf(streams, 2);
  const writesDevNull = stderr.kind === 'file' && stderr.path === devNull;

  return stderr.kind === 'closed' || writesDevNull;
};

const encloses = (group: number | undefined, closingIndex: number, index: number): boolean =>
  group !== undefined && group <= index && index < closingIndex;

const innermostGroupOf = (
  commands: readonly ShellCommand[],
  index: number,
): EnclosingGroup | undefined => {
  let innermost: EnclosingGroup | undefined;

  for (const [closingIndex, command] of commands.entries()) {
    const start = command.group;

    if (start === undefined || !encloses(start, closingIndex, index)) {
      continue;
    }

    if (innermost === undefined || start > innermost.start) {
      innermost = { closing: command, closingIndex, start };
    }
  }

  return innermost;
};

// A command in a child shell inherits the descriptors its parent has when it starts, so an `exec`
// in the parent changes them too. An `exec` in a child shell never reaches the parent.
const runsInShellOf = (command: ShellCommand, shellOwner: ShellCommand): boolean =>
  command.shellId === shellOwner.shellId || command.shellId.startsWith(`${shellOwner.shellId}.`);

// `exec` with only redirections changes the shell's own descriptors for the commands that follow
// it in that shell. A command outside that shell does not inherit the change.
const changesShellStreams = (command: ShellCommand): boolean =>
  command.redirections.length > 0 && runsRedirectionsOnlyExec(command.arguments);

// Applies the `exec` commands whose innermost group is `group`, in source order. The enclosing
// groups apply their own redirections between these passes, so a group redirection that starts
// after an inherited `exec` still wins.
const applyExecRedirections = (
  scope: CompoundScope,
  index: number,
  inherited: Streams,
  group: ShellCommand | undefined,
): Streams => {
  const { commands, execs, from } = scope;
  const target = commands[index];

  if (target === undefined) {
    throw new Error('the exec pass needs a command at its index');
  }

  let streams = inherited;

  for (const exec of execs) {
    if (exec.index < from || exec.index >= index) {
      continue;
    }

    if (!runsInShellOf(target, exec.command)) {
      continue;
    }

    if (exec.innermost?.closing !== group) {
      continue;
    }

    streams = streamsOf(exec.command, streams);
  }

  return streams;
};

const enclosingGroupsOf = (scope: CompoundScope, index: number): readonly EnclosingGroup[] =>
  scope.groups.filter(({ start, closingIndex }) => encloses(start, closingIndex, index));

const enclosingStreams = (scope: CompoundScope, index: number): Streams => {
  const { inherited } = scope;
  const enclosing = enclosingGroupsOf(scope, index);

  let streams = applyExecRedirections(scope, index, inherited, undefined);

  for (const group of enclosing) {
    const groupStreams = streamsOf(group.closing, streams);

    streams = applyExecRedirections(scope, index, groupStreams, group.closing);
  }

  return streams;
};

const compoundScope = (
  commands: readonly ShellCommand[],
  inherited: Streams,
  from = 0,
): CompoundScope => {
  const groups: EnclosingGroup[] = [];
  const execs: ExecCommand[] = [];

  for (const [index, command] of commands.entries()) {
    const start = command.group;

    if (start !== undefined && start >= from) {
      groups.push({ closing: command, closingIndex: index, start });
    }

    if (changesShellStreams(command)) {
      execs.push({ command, index, innermost: innermostGroupOf(commands, index) });
    }
  }

  groups.sort((left, right) => left.start - right.start);

  return { commands, inherited, from, enclosingByIndex: new Map(), groups, execs };
};

const enclosingOf = (scope: CompoundScope, index: number): Streams => {
  const cached = scope.enclosingByIndex.get(index);

  if (cached !== undefined) {
    return cached;
  }

  const enclosing = enclosingStreams(scope, index);

  scope.enclosingByIndex.set(index, enclosing);

  return enclosing;
};

// Where a command's stdout goes when nothing else redirects it.
const stdoutTargetOf = (scope: CompoundScope, index: number): StreamTarget => {
  const command = scope.commands[index];

  if (command === undefined) {
    return terminal;
  }

  return targetOf(streamsOf(command, enclosingOf(scope, index)), 1);
};

// A command in a pipeline writes to the next element, and the element that leaves the pipeline
// decides where the merged stream goes. Following the chain keeps a `2>&1` from reading the pipe
// as the terminal, and still reads a consumer's log file.
const pipelineStdout = (scope: CompoundScope, index: number): StreamTarget | undefined => {
  let target = scope.commands[index]?.pipeTarget;
  const seen = new Set<number>();

  while (target !== undefined && !seen.has(target)) {
    seen.add(target);

    const next = scope.commands[target]?.pipeTarget;

    if (next === undefined) {
      return stdoutTargetOf(scope, target);
    }

    target = next;
  }

  return undefined;
};

const noFacts: CompoundFacts = { shows: false, discards: false, ownDiscards: false };
const failClosedFacts: CompoundFacts = { shows: false, discards: true, ownDiscards: false };

const memberRangeWithFallbackOf = (
  scope: CompoundScope,
  closingIndex: number | undefined,
): { start: number; end: number; fallbackStreams: Streams } => {
  const closing = closingIndex === undefined ? undefined : scope.commands[closingIndex];
  const start = closing?.group ?? 0;
  const end = closingIndex ?? scope.commands.length;
  const pipeStdout = closingIndex === undefined ? undefined : pipelineStdout(scope, closingIndex);

  const fallbackStreams =
    closing === undefined ? scope.inherited : streamsOf(closing, scope.inherited, pipeStdout);

  return { start, end, fallbackStreams };
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

const groupFacts = (
  factsOf: CompoundFactsOf,
  scope: CompoundScope,
  closingIndex: number,
  depth: number,
): CompoundFacts => membersFacts(factsOf, scope, closingIndex, depth);

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
// a visible file. A compound shows it when every member that can fail does. A command that redirects
// anything but leaves stderr discarded hides the failure.
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

  const enclosing = enclosingOf(scope, index);
  const own = streamsOf(command, enclosing, pipelineStdout(scope, index));
  const ownDiscards = command.redirections.length > 0 && discardsStderr(own);
  const script = shellScriptOf(command.arguments);

  if (script !== undefined) {
    const nested = scriptFacts(compoundFacts, script, own, depth);

    return { shows: nested.shows, discards: nested.discards, ownDiscards };
  }

  if (command.group !== undefined) {
    const nestedScope = compoundScope(scope.commands, enclosing, command.group);
    const nested = groupFacts(compoundFacts, nestedScope, index, depth);

    return { shows: nested.shows, discards: nested.discards, ownDiscards };
  }

  return { shows: showsStderr(own), discards: false, ownDiscards };
};

// A backgrounded group is judged as a whole, so its members are not judged again. A command
// backgrounded inside a foreground group still carries its own hidden failure.
const insideBackgroundedGroup = (commands: readonly ShellCommand[], index: number): boolean =>
  innermostGroupOf(commands, index)?.closing.background === true;

const hidesFailure = (scope: CompoundScope, index: number): boolean => {
  const command = scope.commands[index];

  if (command === undefined || !command.background) {
    return false;
  }

  const own = streamsOf(command, enclosingOf(scope, index), pipelineStdout(scope, index));
  const script = shellScriptOf(command.arguments);

  if (script !== undefined || command.group !== undefined) {
    const facts = compoundFacts(scope, index, 0);
    const hidden = !showsStderr(own) && !facts.shows;

    return facts.discards || hidden;
  }

  return !showsStderr(own);
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

// A command the parser creates at an opening parenthesis has no arguments and closes no group, so
// judging it would read the enclosing redirections as its own. A redirection-only command runs no
// program, so it has no failure to hide unless one of its redirections can fail.
const isJudgedCommand = (command: ShellCommand): boolean => {
  if (runsRedirectionsOnlyExec(command.arguments)) {
    return command.redirections.some(redirectionCanFail);
  }

  if (command.group !== undefined || command.arguments.length > 0) {
    return true;
  }

  return command.redirections.some(redirectionCanFail);
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

  if (hidesFailure(scope, index)) {
    return 'hidden';
  }

  if (command.background) {
    return undefined;
  }

  const script = shellScriptOf(command.arguments);

  if (script === undefined) {
    return undefined;
  }

  // A foreground command that runs a script still detaches the script's own backgrounded members.
  // Past the budget the guard cannot inspect the deeper script, so it reports that it cannot tell.
  if (depth > maximumDepth) {
    return 'unverifiable';
  }

  const commands = parseShellCommands(script);

  if (commands === undefined) {
    return undefined;
  }

  const inherited = streamsOf(command, enclosingOf(scope, index), pipelineStdout(scope, index));
  const nested = compoundScope(commands, inherited);

  for (let nestedIndex = 0; nestedIndex < commands.length; nestedIndex += 1) {
    const nestedFailure = judgesHiddenFailure(nested, nestedIndex, depth + 1);

    if (nestedFailure !== undefined) {
      return nestedFailure;
    }
  }

  return undefined;
};

const blockReason =
  'This bash command detaches a process and discards or closes its stderr, so a failure would be hidden. Write the output to a log file, such as `> /tmp/<name>.log 2>&1`, record the command exit status in that log, then read it before reporting the effect.';

const unverifiableReason =
  'This bash command nests scripts deeper than the guard can inspect, so a hidden failure cannot be ruled out. Run the inner command directly, or write its output to a log file such as `> /tmp/<name>.log 2>&1` and read it before reporting the effect.';

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

  const scope = compoundScope(commands, emptyStreams);

  for (let index = 0; index < commands.length; index += 1) {
    const failure = judgesHiddenFailure(scope, index);

    if (failure !== undefined) {
      return { block: true, reason: failure === 'hidden' ? blockReason : unverifiableReason };
    }
  }

  return undefined;
};
