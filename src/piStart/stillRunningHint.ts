// A failed readback and a started tab both tell the caller the terminal may still be running.
export const stillRunningClause = (terminal: string): string =>
  `may still be running; check it with hc get ${terminal}`;
