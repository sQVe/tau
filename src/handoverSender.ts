export interface HandoverSender {
  terminal: string;
  sessionId: string;
}

export interface SenderFacts {
  role: string;
  terminal: string | undefined;
  sessionId: string | undefined;
}

export interface SenderLookupFacts {
  environment: Readonly<Record<string, string | undefined>>;
  messages: readonly string[];
}

export const senderEnvironmentNames = {
  terminal: 'TAU_HANDOVER_SENDER_TERMINAL',
  session: 'TAU_HANDOVER_SENDER_SESSION',
} as const;

// Pi's own rule for `--session-id`. It also keeps a session ID safe as a file name.
const sessionIdExpression = new RegExp('^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$', 'u');

const senderLineExpression = /^Handover sender: terminal (\S+), session (.+)\.$/u;

const senderFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): HandoverSender | undefined => {
  const terminal = environment[senderEnvironmentNames.terminal] ?? '';
  const sessionId = environment[senderEnvironmentNames.session] ?? '';

  if (terminal === '' || !sessionIdExpression.test(sessionId)) {
    return undefined;
  }

  return { terminal, sessionId };
};

export const senderOf = (facts: SenderFacts): HandoverSender | undefined => {
  if (facts.role !== 'lead') {
    return undefined;
  }

  const terminal = facts.terminal ?? '';
  const sessionId = facts.sessionId ?? '';

  if (terminal === '' || sessionId === '') {
    return undefined;
  }

  return { terminal, sessionId };
};

export const senderLine = (sender: HandoverSender): string =>
  `Handover sender: terminal ${sender.terminal}, session ${sender.sessionId}.`;

export const parseSenderLine = (text: string): HandoverSender | undefined => {
  const firstLine = text.split(/\r?\n/u)[0] ?? '';
  const match = senderLineExpression.exec(firstLine);

  if (match === null) {
    return undefined;
  }

  const terminal = match[1] ?? '';
  const sessionId = match[2] ?? '';

  if (terminal === '' || !sessionIdExpression.test(sessionId)) {
    return undefined;
  }

  return { terminal, sessionId };
};

export const senderEnvironment = (sender: HandoverSender): Record<string, string> => ({
  [senderEnvironmentNames.terminal]: sender.terminal,
  [senderEnvironmentNames.session]: sender.sessionId,
});

export const lookupSender = (facts: SenderLookupFacts): HandoverSender | undefined => {
  for (let index = facts.messages.length - 1; index >= 0; index -= 1) {
    const message = facts.messages[index] ?? '';
    const sender = parseSenderLine(message);

    if (sender !== undefined) {
      return sender;
    }
  }

  return senderFromEnvironment(facts.environment);
};
