import { WorkerCapacityFullError } from './controller/controller.js';
import { EvidenceUnavailableError } from './controller/record.js';
import { modelEvidenceNotice } from './presentation.js';

export interface ToolResult<Details> {
  content: { type: 'text'; text: string }[];
  details: Details;
  isError?: boolean;
  terminate?: boolean;
}

export type EvidenceDetails = Parameters<typeof modelEvidenceNotice>[0];

// The model reads the same unreadable-evidence shape here as in notices.
export const evidenceResult = (error: unknown): ToolResult<EvidenceDetails> => {
  if (!(error instanceof EvidenceUnavailableError)) {
    throw error;
  }

  const details = {
    taskId: error.taskId,
    ...(error.taskName === undefined ? {} : { name: error.taskName }),
    evidenceError: error.evidenceError,
    recovery: error.recovery,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(modelEvidenceNotice(details)) }],
    details,
  };
};

export const launchErrorResult = (
  refuseCapacity: () => void,
  error: unknown,
): ToolResult<EvidenceDetails | undefined> => {
  if (error instanceof WorkerCapacityFullError) {
    refuseCapacity();

    return {
      content: [{ type: 'text' as const, text: error.message }],
      details: undefined,
      isError: true,
      terminate: true,
    };
  }

  return evidenceResult(error);
};
