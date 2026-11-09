export interface ArrivalFacts {
  // Tau saw agent_start and not yet agent_settled.
  runActive: boolean;
  // The state of the run's abort signal. Pi's TUI clears its queue and aborts in one step, so a
  // live signal means no queue clear has happened yet.
  signal: 'live' | 'aborted' | 'none';
}

// A message steered after Pi's queue clear stays in Pi's queue past an aborted settle, where Tau
// would also show it again. Hold it until the run settles instead.
export const holdsArrival = ({ runActive, signal }: ArrivalFacts): boolean =>
  runActive && signal !== 'live';
