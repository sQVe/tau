import type { Coverage } from './taskMapping.ts';
import { readTask } from './taskSignals.ts';
import type { TaskSignalSources } from './taskSignals.ts';

export type TaskTranscriptsRead =
  | { status: 'read'; manager: string[]; workers: string[]; coverage: Coverage }
  | { status: 'failed'; reason: string };

export const readTaskTranscripts = async (
  sources: TaskSignalSources,
): Promise<TaskTranscriptsRead> => {
  const read = await readTask(sources);

  if (read.status === 'failed') {
    return read;
  }

  const workers = [...read.workerReads.values()].flatMap((worker) => worker.sessions).toSorted();

  return {
    status: 'read',
    manager: read.task.transcripts,
    workers,
    coverage: read.task.coverage,
  };
};
