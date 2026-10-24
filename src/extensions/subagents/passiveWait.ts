type HeredocReplacement = (span: string, quote: string, rest: string) => string;

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
const heredocSource = String.raw`(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_][\w.-]*)\1([^\n]*)(?:\n(?:[\s\S]*?\n)??\t*\2(?=\n|$)|[\s\S]*$)`;

const heredoc = new RegExp(heredocSource, 'g');

// One left-to-right scan, so a heredoc marker inside a single-quoted span is text and a heredoc body
// is consumed before its contents are scanned. Each alternative matches a text in one way.
const quotedOrHeredoc = new RegExp(
  String.raw`\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|${heredocSource}`,
  'g',
);

// A double-quoted span may hold a heredoc in a command substitution.
const replaceHeredocs = (command: string, replacement: HeredocReplacement): string =>
  command.replace(quotedOrHeredoc, (span: string) => {
    if (span.startsWith('\\') || span.startsWith("'")) {
      return span;
    }

    return span.replace(heredoc, (inner, quote: string, _delimiter, rest: string) =>
      replacement(inner, quote, rest),
    );
  });

// A # starts a comment only at the start of a word. Quoted spans and heredocs match first, so a #
// inside them stays text.
const quotedHeredocOrComment = new RegExp(
  String.raw`${quotedOrHeredoc.source}|(?<=^|[\s;&|()<>])#[^\n]*`,
  'g',
);

// An escaped blank before # joins it to the word, so that # starts no comment.
const withoutComments = (command: string): string => {
  let escapeEnd = -1;

  return command.replace(
    quotedHeredocOrComment,
    (span: string, _quote, _delimiter, _rest, offset: number) => {
      if (span.startsWith('\\')) {
        escapeEnd = offset + span.length;
      }

      const isComment = span.startsWith('#') && offset !== escapeEnd;

      return isComment ? '' : span;
    },
  );
};

const withoutHeredocText = (command: string): string =>
  replaceHeredocs(command, (_span, _quote, rest) => `<<EOF${rest}`);

const withoutLiteralHeredocText = (command: string): string =>
  replaceHeredocs(command, (span, quote, rest) => (quote === '' ? span : `<<EOF${rest}`));

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

export const passiveWaitRefusal = (input: string, facts: PassiveWaitFacts): string | undefined => {
  const command = withoutComments(input);
  const prose = withoutQuotedText(withoutHeredocText(command));
  const expandable = withoutLiteralHeredocText(command);
  const shellRuns = runsShell.test(prose) || quotedShellName.test(expandable);
  // A substitution can run text whose quotes this guard does not parse, so its sleeps count.
  const substitutedText = withoutSingleQuotedText(expandable);
  const substitutes = hasCommandSubstitution(substitutedText);

  const runnable = substitutes ? expandable : prose;
  const sleepText = shellRuns ? command : runnable;
  const loopText = substitutes ? substitutedText : prose;
  const waitText = shellRuns ? withoutQuotedText(command) : loopText;

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
