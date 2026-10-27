import { parseShellCommands } from '../../shell.js';
import type { ShellCommand } from '../../shell.js';

export interface PassiveWaitFacts {
  hasActiveWorkers: boolean;
  delegating: boolean;
}

interface WaitFacts {
  waitsPassively: boolean;
  sleepSeconds: number;
}

// A sleep this long while workers run waits on them, so the call is refused.
const blockedSleepSeconds = 30;

const unitSeconds: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };

const sleepOperand = /^((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|infinity)([smhd]?)$/;

// A shell can run any text it reads, through a pipe, a heredoc, a here-string, or a script file.
const shellNames = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'eval',
  'source',
  '$shell',
  `\${shell}`,
]);

const assignment = /^\w+=/;

const printingNames = new Set(['echo', 'printf']);

const keywords = new Set(['!', '{', 'do', 'elif', 'else', 'if', 'then', 'until', 'while']);

const rawLoopWithSleep =
  /\b(?:until|while(?!\s+(?:\w+=\S*\s+)*read\b))(?:(?!\bdone\b)[\s\S])*?\bdo\b(?:(?!\bdone\b)[\s\S])*?\bsleep\b/;

const rawWatcherPatterns = [
  /\bgh\s+run\s+watch\b/,
  /\bgh\s+pr\s+checks\b[^;&|\n]*\s--watch\b/,
  /\baws\s+logs\s+tail\b[^;&|\n]*(?:\s--follow\b|\s-f\b)/,
  /(?:^|[;&|(\n])\s*watch\s/,
];

const rawSleep = /\bsleep((?:\s+\d+(?:\.\d+)?[smhd]?\b)+)/g;

const commandName = (word: string) => word.slice(word.lastIndexOf('/') + 1).toLowerCase();

const operandSeconds = (word: string): number | undefined => {
  const match = sleepOperand.exec(word);

  if (match === null) {
    return undefined;
  }

  const amount = match[1] ?? '';
  const value = amount.startsWith('inf') ? Infinity : Number(amount);

  return value * (unitSeconds[match[2] ?? ''] ?? 1);
};

const printsOnly = ({ words }: ShellCommand) => {
  const name = words.find((word) => !keywords.has(word) && !assignment.test(word)) ?? '';

  return printingNames.has(commandName(name));
};

const sleepSecondsOf = (command: ShellCommand): number => {
  let total = 0;
  let sleeping = false;

  if (printsOnly(command)) {
    return total;
  }

  for (const word of command.words) {
    const seconds: number | undefined = sleeping ? operandSeconds(word) : undefined;

    sleeping = seconds !== undefined || commandName(word) === 'sleep';
    total += seconds ?? 0;
  }

  return total;
};

const sleeps = (command: ShellCommand) => {
  const hasSleep = command.words.some((word) => commandName(word) === 'sleep');

  return hasSleep && !printsOnly(command);
};

const followsWords = (words: string[], index: number, expected: string[]) =>
  expected.every((word, offset) => words[index + 1 + offset] === word);

const watchesWithGh = (words: string[], index: number) => {
  const checks = followsWords(words, index, ['pr', 'checks']);
  const watchesChecks = checks && words.includes('--watch');

  return followsWords(words, index, ['run', 'watch']) || watchesChecks;
};

const tailsAwsLogs = (words: string[], index: number) => {
  const tails = followsWords(words, index, ['logs', 'tail']);
  const follows = words.includes('--follow') || words.includes('-f');

  return tails && follows;
};

const watchesAt = (words: string[], index: number) => {
  const name = commandName(words[index] ?? '');

  if (name === 'gh') {
    return watchesWithGh(words, index);
  }

  return name === 'aws' && tailsAwsLogs(words, index);
};

const watches = ({ words }: ShellCommand) => {
  const runsWatch = words[0] === 'watch' && words.length > 1;

  return runsWatch || words.some((_word, index) => watchesAt(words, index));
};

// A while loop that reads input ends with the input, so only other conditions count as waiting.
const opensWaitingLoop = ({ words }: ShellCommand) => {
  const [keyword, ...condition] = words;
  const test = condition.find((word) => !assignment.test(word));
  const whileNotReading = keyword === 'while' && test !== 'read';

  return keyword === 'until' || whileNotReading;
};

const waitsInLoop = (commands: ShellCommand[]) => {
  let inLoop = false;

  for (const command of commands) {
    if (opensWaitingLoop(command)) {
      inLoop = true;
    } else if (command.words[0] === 'done') {
      inLoop = false;
    } else if (inLoop && sleeps(command)) {
      return true;
    }
  }

  return false;
};

const runsShell = ({ words }: ShellCommand) =>
  words.some((word) => shellNames.has(commandName(word)));

const rawWaitFacts = (source: string): WaitFacts => {
  let sleepSeconds = 0;

  for (const [, operands] of source.matchAll(rawSleep)) {
    for (const operand of (operands ?? '').split(/\s+/)) {
      sleepSeconds += operandSeconds(operand) ?? 0;
    }
  }

  const waitsInRawLoop = rawLoopWithSleep.test(source);
  const waitsOnWatcher = rawWatcherPatterns.some((pattern) => pattern.test(source));

  return { waitsPassively: waitsInRawLoop || waitsOnWatcher, sleepSeconds };
};

// A shell may run any text in the source, so a source that runs one is also scanned whole. One scan
// cannot count a sleep twice or split it across words.
const waitFactsOf = (source: string): WaitFacts => {
  const commands = parseShellCommands(source);

  if (commands === undefined) {
    return rawWaitFacts(source);
  }

  const waitsOnWatcher = commands.some(watches);
  const waitsPassively = waitsInLoop(commands) || waitsOnWatcher;
  const sleepSeconds = commands.reduce((total, command) => total + sleepSecondsOf(command), 0);

  if (!commands.some(runsShell)) {
    return { waitsPassively, sleepSeconds };
  }

  const rawFacts = rawWaitFacts(source);

  return {
    waitsPassively: waitsPassively || rawFacts.waitsPassively,
    sleepSeconds: Math.max(sleepSeconds, rawFacts.sleepSeconds),
  };
};

const refusalReason = (delegating: boolean): string => {
  const lines = [
    'Do not wait in a tool call. Check the state once, report it and what you wait for, and end your turn.',
  ];

  if (delegating) {
    lines.push(
      'If the user asked for the wait, such as CI before a merge, give it to a worker with a deadline.',
    );
  } else {
    lines.push('The user resumes the session when the wait is over.');
  }

  return lines.join(' ');
};

// A running tool call holds worker notices back, so a long sleep delays the notice it waits for.
export const passiveWaitRefusal = (input: string, facts: PassiveWaitFacts): string | undefined => {
  const { waitsPassively, sleepSeconds } = waitFactsOf(input);
  const delaysWorkers = facts.hasActiveWorkers && sleepSeconds >= blockedSleepSeconds;

  if (!waitsPassively && !delaysWorkers) {
    return undefined;
  }

  return refusalReason(facts.delegating);
};
