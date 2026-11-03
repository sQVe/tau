export const reportMessageType = 'tau-worker-report';

export const questionMessageType = 'tau-worker-question';

export const deadlineMessageType = 'tau-worker-deadline';

// The task prompt carries this line so a reload can tell an assigned task from other user text.
export const taskPromptHeader = (assignmentId: string): string => `Task ${assignmentId}:`;
