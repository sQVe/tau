export interface PassiveWaitFacts {
  hasActiveWorkers: boolean;
  delegating: boolean;
}

// A sleep this long while workers run waits on them, so the call is refused.
const blockedSleepSeconds = 30;

const unitSeconds: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };

const loopWithSleep =
  /\b(?:while|until)\b(?:(?!\bdone\b)[\s\S])*?\bdo\b(?:(?!\bdone\b)[\s\S])*?\bsleep\b/;

const passiveWaitPatterns = [
  /\bgh\s+run\s+watch\b/,
  /\bgh\s+pr\s+checks\b[^;&|\n]*\s--watch\b/,
  /\baws\s+logs\s+tail\b[^;&|\n]*(?:\s--follow\b|\s-f\b)/,
  /(?:^|[;&|(\n])\s*watch\s/,
];

const withoutQuotedText = (command: string): string =>
  command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");

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
  const unquoted = withoutQuotedText(command);
  const waitsInLoop = loopWithSleep.test(command);
  const waitsOnWatcher = passiveWaitPatterns.some((pattern) => pattern.test(unquoted));
  const waitsPassively = waitsInLoop || waitsOnWatcher;
  const sleepsLong = totalSleepSeconds(command) >= blockedSleepSeconds;
  const delaysWorkers = facts.hasActiveWorkers && sleepsLong;

  if (!waitsPassively && !delaysWorkers) {
    return undefined;
  }

  return refusalReason(facts.delegating);
};
