// The parent marks a worker process with its task record directory.
export const isWorkerProcess = (): boolean => {
  // oxlint-disable-next-line node/no-process-env -- The parent sets the marker in the worker pane environment.
  const recordDirectory = process.env.TAU_WORKER_RECORD;

  return recordDirectory != null && recordDirectory !== '';
};
