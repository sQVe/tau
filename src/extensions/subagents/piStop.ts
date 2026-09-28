// Decides the next step in stopping a Pi worker from facts the caller read. tests/structure.test.ts
// keeps this module pure.

export interface PiStopFacts {
  // Herdr still lists the worker's terminal.
  paneFound: boolean;
  // Saved ownership names the worker's process. Without it, only the pane identifies the worker.
  owned: boolean;
  // The owned process is gone.
  exited: boolean;
  // Tau already closed the pane.
  closed: boolean;
  // A finished worker had its moment to exit by itself.
  graceElapsed: boolean;
}

export type PiStopStep = 'stopped' | 'processRemains' | 'close' | 'wait';

export const decidePiStop = (facts: PiStopFacts): PiStopStep => {
  if (!facts.paneFound) {
    if (!facts.owned || facts.exited) {
      return 'stopped';
    }

    // Herdr removes a pane only after its process exits, unless Tau just closed it.
    return facts.closed ? 'wait' : 'processRemains';
  }

  return !facts.closed && !facts.exited && facts.graceElapsed ? 'close' : 'wait';
};
