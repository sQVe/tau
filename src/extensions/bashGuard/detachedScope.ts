import type { ShellCommand, ShellRedirection } from '../../shell/shell.js';
import { runsRedirectionsOnlyExec } from '../../wrapperAnalysis.js';
import { streamsOf, targetOf, terminal } from './detachedStreams.js';
import type { StreamTarget, Streams } from './detachedStreams.js';

export interface CompoundScope {
  commands: readonly ShellCommand[];
  inherited: Streams;
  // Members below this index sit inside a group whose redirections `inherited` already includes.
  from: number;
  enclosingByIndex: Map<string, Streams>;
  groups: readonly EnclosingGroup[];
  execs: readonly ExecCommand[];
}

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

interface ExecReach {
  readonly reaches: boolean;
  readonly closedBeforeTarget: boolean;
  readonly inSameGroup: boolean;
}

const encloses = (group: number | undefined, closingIndex: number, index: number): boolean =>
  group !== undefined && group <= index && index < closingIndex;

const innermostGroupWhere = (
  commands: readonly ShellCommand[],
  index: number,
  matches: (group: EnclosingGroup) => boolean,
): EnclosingGroup | undefined => {
  let innermost: EnclosingGroup | undefined;

  for (const [closingIndex, command] of commands.entries()) {
    const start = command.group;

    if (start === undefined || !encloses(start, closingIndex, index)) {
      continue;
    }

    const group = { closing: command, closingIndex, start };

    if (!matches(group)) {
      continue;
    }

    if (innermost === undefined || start > innermost.start) {
      innermost = group;
    }
  }

  return innermost;
};

export const innermostGroupOf = (
  commands: readonly ShellCommand[],
  index: number,
): EnclosingGroup | undefined => innermostGroupWhere(commands, index, () => true);

// A command in a child shell inherits the descriptors its parent has when it starts, so an `exec`
// in the parent changes them too. An `exec` in a child shell never reaches the parent.
const runsInShellOf = (command: ShellCommand, shellOwner: ShellCommand): boolean =>
  command.shellId === shellOwner.shellId || command.shellId.startsWith(`${shellOwner.shellId}.`);

// Only a parenthesis group runs its body in a child shell. A brace group or a compound keyword runs
// in the current shell, so an `exec` there changes the streams outside the group too.
const spawnsSubshell = (
  commands: readonly ShellCommand[],
  { closing, start }: EnclosingGroup,
): boolean => (commands[start]?.depth ?? 0) > closing.depth;

// A non-subshell group that closed before the target still leaves its `exec` in effect.
const closedNonSubshellBefore = (
  commands: readonly ShellCommand[],
  group: EnclosingGroup,
  index: number,
): boolean => !spawnsSubshell(commands, group) && group.closingIndex < index;

// `exec` with only redirections changes the shell's own descriptors for the commands that follow
// it in that shell. A command outside that shell does not inherit the change.
const changesShellStreams = (command: ShellCommand): boolean =>
  command.redirections.length > 0 && runsRedirectionsOnlyExec(command.arguments);

// An `exec` in a closed non-subshell group reaches the target. Inside an enclosing group, only a
// group that opened within it counts, because the enclosing group's redirection ran before this
// one's `exec` did.
const closedExecReaches = (
  commands: readonly ShellCommand[],
  group: EnclosingGroup | undefined,
  innermost: EnclosingGroup | undefined,
  index: number,
): boolean => {
  if (innermost === undefined || !closedNonSubshellBefore(commands, innermost, index)) {
    return false;
  }

  return group === undefined || innermost.start >= group.start;
};

const enclosingGroupsOf = (scope: CompoundScope, index: number): readonly EnclosingGroup[] =>
  scope.groups.filter(({ start, closingIndex }) => encloses(start, closingIndex, index));

const outputRedirectionOperators: ReadonlySet<string> = new Set(['>', '>>', '>|', '>&']);

// The descriptors a redirection changes. `&>` changes both output streams.
const redirectionDescriptors = (redirection: ShellRedirection): number[] => {
  const { fileDescriptor, operator } = redirection;

  if (operator === '&>' || operator === '&>>') {
    return [1, 2];
  }

  if (outputRedirectionOperators.has(operator)) {
    return [fileDescriptor ?? 1];
  }

  return [fileDescriptor ?? 0];
};

// A closed non-subshell group restores every descriptor its own redirection changed, so an `exec`
// inside it cannot carry those changes past the group.
const restoredDescriptorsOf = (
  scope: CompoundScope,
  execIndex: number,
  targetIndex: number,
): ReadonlySet<number> => {
  const descriptors = new Set<number>();

  for (const group of enclosingGroupsOf(scope, execIndex)) {
    if (spawnsSubshell(scope.commands, group) || group.closingIndex >= targetIndex) {
      continue;
    }

    for (const redirection of group.closing.redirections) {
      for (const descriptor of redirectionDescriptors(redirection)) {
        descriptors.add(descriptor);
      }
    }
  }

  return descriptors;
};

const restoredStreams = (
  streams: Streams,
  before: Streams,
  descriptors: ReadonlySet<number>,
): Streams => {
  if (descriptors.size === 0) {
    return streams;
  }

  const restored = new Map(streams);

  for (const descriptor of descriptors) {
    const target = before.get(descriptor);

    if (target === undefined) {
      restored.delete(descriptor);
    } else {
      restored.set(descriptor, target);
    }
  }

  return restored;
};

// An `exec` reaches a target in its own group, or through a closed non-subshell group before it.
const execReachOf = (
  scope: CompoundScope,
  exec: ExecCommand,
  group: EnclosingGroup | undefined,
  index: number,
): ExecReach => {
  const innermost = exec.innermost;
  const closedBeforeTarget = closedExecReaches(scope.commands, group, innermost, index);
  const inSameGroup = innermost !== undefined && innermost.closing === group?.closing;

  const reaches = innermost === undefined ? group === undefined : inSameGroup || closedBeforeTarget;

  return { reaches, closedBeforeTarget, inSameGroup };
};

// Applies the `exec` commands whose innermost group is `group`, in source order. The enclosing
// groups apply their own redirections between these passes, so a group redirection that starts
// after an inherited `exec` still wins. A non-subshell group's `exec` still reaches the commands
// after the group closes, because the brace group runs in the same shell, and it runs after the
// redirection of every group that encloses it.
const applyExecRedirections = (
  scope: CompoundScope,
  index: number,
  inherited: Streams,
  group: EnclosingGroup | undefined,
): Streams => {
  const { commands, execs, from } = scope;
  const target = commands[index];

  if (target === undefined) {
    return inherited;
  }

  let streams = inherited;

  for (const exec of execs) {
    if (exec.index < from || exec.index >= index) {
      continue;
    }

    if (!runsInShellOf(target, exec.command)) {
      continue;
    }

    const reach = execReachOf(scope, exec, group, index);

    if (!reach.reaches) {
      continue;
    }

    const applied = streamsOf(exec.command, streams);
    const restoresDescriptors = reach.closedBeforeTarget && !reach.inSameGroup;

    const restored = restoresDescriptors
      ? restoredDescriptorsOf(scope, exec.index, index)
      : new Set<number>();

    streams = restoredStreams(applied, streams, restored);
  }

  return streams;
};

const enclosingStreams = (
  scope: CompoundScope,
  index: number,
  pipeStdout: StreamTarget | undefined,
): Streams => {
  const { inherited } = scope;
  const enclosing = enclosingGroupsOf(scope, index);

  let streams = applyExecRedirections(scope, index, inherited, undefined);

  // The pipeline redirects the element's stdout when the shell builds the pipeline, before the
  // commands of an enclosing group run, so a group redirection still wins over it.
  if (pipeStdout !== undefined) {
    streams = new Map([...streams.entries(), [1, pipeStdout] as const]);
  }

  for (const group of enclosing) {
    const groupStreams = streamsOf(group.closing, streams);

    streams = applyExecRedirections(scope, index, groupStreams, group);
  }

  return streams;
};

export const compoundScope = (
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

  groups.sort((left, right) => left.start - right.start || right.closingIndex - left.closingIndex);

  return { commands, inherited, from, enclosingByIndex: new Map(), groups, execs };
};

// The cache key includes the pipe target, because a caller that passes another target for the same
// index computes different streams.
const streamTargetKey = (target: StreamTarget | undefined): string => {
  if (target === undefined) {
    return '';
  }

  return target.kind === 'file' ? `file:${target.path}` : target.kind;
};

export const enclosingOf = (
  scope: CompoundScope,
  index: number,
  pipeStdout?: StreamTarget,
): Streams => {
  const cacheKey = `${index}|${streamTargetKey(pipeStdout)}`;
  const cached = scope.enclosingByIndex.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const enclosing = enclosingStreams(scope, index, pipeStdout);

  scope.enclosingByIndex.set(cacheKey, enclosing);

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
export const pipelineStdout = (scope: CompoundScope, index: number): StreamTarget | undefined => {
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

export const memberRangeWithFallbackOf = (
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
