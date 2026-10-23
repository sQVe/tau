export type ProcessState = 'running' | 'gone' | 'unknown';

// Reads `ps -A -o pgid=,stat=` output. A zombie cannot be killed, so only a member whose state does
// not start with Z keeps the group running.
export const groupHasRunningMember = (psOutput: string, groupId: number): boolean =>
  psOutput.split('\n').some((line) => {
    const [pgid, state] = line.trim().split(/\s+/u);

    return pgid === String(groupId) && state !== undefined && !state.startsWith('Z');
  });

// Maps the error code of a signal 0 probe. `undefined` means the probe succeeded. A process the
// user cannot signal (EPERM) still runs.
export const stateFromProbe = (errorCode: string | undefined): ProcessState => {
  if (errorCode === undefined || errorCode === 'EPERM') {
    return 'running';
  }

  return errorCode === 'ESRCH' ? 'gone' : 'unknown';
};

// `psOutput` is undefined when the process table could not be read.
export const groupStateFromTable = (
  psOutput: string | undefined,
  groupId: number,
): ProcessState => {
  if (psOutput === undefined) {
    return 'unknown';
  }

  return groupHasRunningMember(psOutput, groupId) ? 'running' : 'gone';
};
