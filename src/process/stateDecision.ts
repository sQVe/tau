export type ProcessState = 'running' | 'gone' | 'unknown';

export const groupHasRunningMember = (psOutput: string, groupId: number): boolean =>
  psOutput.split('\n').some((line) => {
    const [pgid, state] = line.trim().split(/\s+/u);

    return pgid === String(groupId) && state !== undefined && !state.startsWith('Z');
  });

export const stateFromProbe = (errorCode: string | undefined): ProcessState => {
  if (errorCode === undefined || errorCode === 'EPERM') {
    return 'running';
  }

  return errorCode === 'ESRCH' ? 'gone' : 'unknown';
};

export const groupStateFromTable = (
  psOutput: string | undefined,
  groupId: number,
): ProcessState => {
  if (psOutput === undefined) {
    return 'unknown';
  }

  return groupHasRunningMember(psOutput, groupId) ? 'running' : 'gone';
};
