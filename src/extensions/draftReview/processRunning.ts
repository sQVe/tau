// A process the user cannot signal (EPERM) still runs.
export const isProcessRunning = (processId: number): boolean => {
  try {
    process.kill(processId, 0);

    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
};
