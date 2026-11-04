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

// Only the interactive Pi that leads the terminal's foreground process group may label the
// terminal. A nested non-interactive Pi shares the terminal but must leave its labels alone.
const ownsTerminal = (facts: StartFacts): boolean =>
  facts.foregroundPid !== undefined && facts.foregroundPid === facts.processPid;

// A non-TUI Pi or a Pi without an hc terminal must not even read the terminal, because `hc get`
// on a stopped core starts a new core.
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

// A process that received a termination signal is being restarted, so it keeps its labels for the
// shell to resume. A normal quit clears them, so the terminal comes back to a plain prompt.
export const shouldClearLabels = (facts: ShutdownFacts): boolean => !facts.signalReceived;
