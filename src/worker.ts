export const isWorkerProcess = (): boolean => {
  // oxlint-disable-next-line node/no-process-env -- The parent sets the marker in the worker pane environment.
  return process.env.TAU_ROLE === 'worker';
};
