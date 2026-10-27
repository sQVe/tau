const leavesDirectory = (path: string) => path === '..' || path.startsWith('../');

export const worktreePath = (fromSession: string, fromCanonical: string): string =>
  leavesDirectory(fromSession) ? fromCanonical : fromSession;
