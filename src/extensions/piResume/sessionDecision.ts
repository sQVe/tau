export interface ReadFacts {
  interactive: boolean;
  terminalId: string | undefined;
}

export interface StartFacts {
  interactive: boolean;
  terminalId: string | undefined;
  foregroundPid: number | undefined;
  processPid: number;
  sessionFile: string | undefined;
  signalReceived: boolean;
}

export interface ShutdownFacts {
  signalReceived: boolean;
}

const ownsTerminal = (facts: StartFacts): boolean =>
  facts.foregroundPid !== undefined && facts.foregroundPid === facts.processPid;

export const shouldReadTerminal = (
  facts: ReadFacts,
): facts is ReadFacts & { terminalId: string } => {
  if (!facts.interactive) {
    return false;
  }

  return facts.terminalId !== undefined;
};

export const shouldLabelSession = (
  facts: StartFacts,
): facts is StartFacts & { terminalId: string; sessionFile: string } => {
  if (facts.signalReceived) {
    return false;
  }

  if (!shouldReadTerminal(facts)) {
    return false;
  }

  if (!ownsTerminal(facts)) {
    return false;
  }

  return facts.sessionFile !== undefined;
};

export const shouldClearLabels = (facts: ShutdownFacts): boolean => !facts.signalReceived;
