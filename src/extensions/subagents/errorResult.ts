import { WorkerCapacityFullError } from './capacityRefusal.js';

export interface ToolResult<Details> {
  content: { type: 'text'; text: string }[];
  details: Details;
  isError?: boolean;
  terminate?: boolean;
}

export const launchErrorResult = (error: unknown): ToolResult<undefined> => {
  if (error instanceof WorkerCapacityFullError) {
    return {
      content: [{ type: 'text' as const, text: error.message }],
      details: undefined,
      isError: true,
      terminate: true,
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  return {
    content: [{ type: 'text' as const, text: message }],
    details: undefined,
    isError: true,
  };
};
