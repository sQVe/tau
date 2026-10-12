// Reads `ps -A -o pgid=,stat=` output. A zombie cannot be killed, so only a member whose state does
// not start with Z keeps the group running.
export const groupHasRunningMember = (psOutput: string, groupId: number): boolean =>
  psOutput.split('\n').some((line) => {
    const [pgid, state] = line.trim().split(/\s+/u);

    return pgid === String(groupId) && state !== undefined && !state.startsWith('Z');
  });
