export interface PassiveWaitFacts {
  hasActiveWorkers: boolean;
  delegating: boolean;
}

// A sleep this long while workers run waits on them, so the call is refused.
const blockedSleepSeconds = 30;

const unitSeconds: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };

// A while loop that reads input ends with the input, so only other conditions count as waiting.
const loopWithSleep =
  /\b(?:until|while(?!\s+(?:\w+=\S*\s+)*read\b))(?:(?!\bdone\b)[\s\S])*?\bdo\b(?:(?!\bdone\b)[\s\S])*?\bsleep\b/;

const passiveWaitPatterns = [
  /\bgh\s+run\s+watch\b/,
  /\bgh\s+pr\s+checks\b[^;&|\n]*\s--watch\b/,
  /\baws\s+logs\s+tail\b[^;&|\n]*(?:\s--follow\b|\s-f\b)/,
  /(?:^|[;&|(\n])\s*watch\s/,
];

const shellScriptPrefix = /\b(?:sh|bash|zsh)(?:\s+-[a-z]+)*\s+-[a-z]*c\s+$/;

// An escaped character is matched first, so an escaped quote never opens a quoted span.
const quotedText = /\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*"/g;

const escapedCharacter = /\\[\s\S]/g;

// Quoted text is prose unless it is the script a shell runs.
const withoutQuotedText = (command: string): string =>
  command.replace(quotedText, (span: string, offset: number) => {
    const isEscape = span.startsWith('\\');
    const isScript = shellScriptPrefix.test(command.slice(0, offset));

    return isEscape || isScript ? span : "''";
  });

const withoutSingleQuotedText = (command: string): string =>
  command.replace(quotedText, (span: string) => (span.startsWith("'") ? "''" : span));

// A heredoc body is text up to its delimiter line. With a quoted delimiter, nothing in it expands.
const heredoc =
  /(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_][\w.-]*)\1([^\n]*)(?:\n(?:[\s\S]*?\n)??\t*\2(?=\n|$)|[\s\S]*$)/g;

const withoutHeredocText = (command: string): string =>
  command.replace(heredoc, (_span, _quote, _delimiter, rest: string) => `<<EOF${rest}`);

const withoutLiteralHeredocText = (command: string): string =>
  command.replace(heredoc, (span: string, quote: string, _delimiter, rest: string) =>
    quote === '' ? span : `<<EOF${rest}`,
  );

const shellNames = String.raw`(?:sh|bash|zsh|dash|ksh|fish|eval|source|\$\{?SHELL\}?)`;

// A shell can run any text it reads, through a pipe, a heredoc, a here-string, or a script file.
const runsShell = new RegExp(String.raw`(?:^|[\s;&|(/])${shellNames}(?=[\s<>;&|)]|$)`);

const quotedShellName = new RegExp(String.raw`(['"])(?:[^'"\s]*/)?${shellNames}\1`);

const commandSubstitution = /\$\(|`/;

// Escapes are removed in order, so a backslash pair never hides the substitution after it.
const hasCommandSubstitution = (text: string): boolean =>
  commandSubstitution.test(text.replace(escapedCharacter, ''));

// A running tool call holds worker notices back, so a long sleep delays the notice it waits for.
// Sleep sums its operands, and chained sleeps add up, so count every operand in the command.
const totalSleepSeconds = (command: string): number => {
  let total = 0;

  for (const [, operands] of command.matchAll(/\bsleep((?:\s+\d+(?:\.\d+)?[smhd]?\b)+)/g)) {
    for (const [, amount, unit] of (operands ?? '').matchAll(/(\d+(?:\.\d+)?)([smhd]?)/g)) {
      total += Number(amount) * (unitSeconds[unit ?? ''] ?? 1);
    }
  }

  return total;
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

export const passiveWaitRefusal = (
  command: string,
  facts: PassiveWaitFacts,
): string | undefined => {
  const prose = withoutQuotedText(withoutHeredocText(command));
  const expandable = withoutLiteralHeredocText(command);
  const shellRuns = runsShell.test(prose) || quotedShellName.test(expandable);
  // A substitution can run text whose quotes this guard does not parse, so its sleeps count.
  const substitutes = hasCommandSubstitution(withoutSingleQuotedText(expandable));

  const runnable = substitutes ? expandable : prose;
  const sleepText = shellRuns ? command : runnable;
  const waitText = shellRuns ? withoutQuotedText(command) : prose;

  const waitsInLoop = loopWithSleep.test(waitText);
  const waitsOnWatcher = passiveWaitPatterns.some((pattern) => pattern.test(waitText));
  const waitsPassively = waitsInLoop || waitsOnWatcher;

  const sleepsLong = totalSleepSeconds(sleepText) >= blockedSleepSeconds;
  const delaysWorkers = facts.hasActiveWorkers && sleepsLong;

  if (!waitsPassively && !delaysWorkers) {
    return undefined;
  }

  return refusalReason(facts.delegating);
};
