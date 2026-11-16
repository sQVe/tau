export const repository = 'github.com/owner/repo';

export const sessionHeader = (cwd: string): string =>
  JSON.stringify({ type: 'session', id: 's', timestamp: '2026-11-01T00:00:00.000Z', cwd });

const entry = (id: string, timestamp: string, message: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', id, timestamp, message });

const call = (
  id: string,
  timestamp: string,
  name: string,
  parameters: Record<string, unknown>,
  details: Record<string, unknown> = {},
) => [
  entry(id, timestamp, {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: parameters }],
  }),
  entry(`${id}-result`, timestamp, {
    role: 'toolResult',
    toolCallId: id,
    details,
  }),
];

export const published = (pr: number): string[] =>
  call('verify', '2026-11-01T00:01:00.000Z', 'pr', {
    action: 'verify',
    repository,
    pr,
  });

export const feedbackRead = (index: number, pr: number): string[] =>
  call(`feedback-${index}`, `2026-11-01T00:0${index + 2}:00.000Z`, 'pr_feedback', {
    action: 'read',
    pr,
  });

export const workerLaunch = (workerId: string): string[] =>
  call(
    'launch',
    '2026-11-01T00:01:30.000Z',
    'subagent',
    { profile: 'worker' },
    { taskId: workerId },
  );
