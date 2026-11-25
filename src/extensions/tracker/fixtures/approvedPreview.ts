import type { SessionEntry } from '@earendil-works/pi-coding-agent';

interface QuestionOverrides {
  question?: string;
  kind?: string;
  preview?: string;
  multiSelect?: boolean;
}

interface QuestionFixture {
  question: string;
  kind: string;
  options: readonly unknown[];
  preview?: string;
  multiSelect?: boolean;
}

export const entry = (message: unknown): SessionEntry =>
  ({ type: 'message', message }) as unknown as SessionEntry;

export const user = (): SessionEntry =>
  entry({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });

export const askCall = (id: string, questions: readonly unknown[]): SessionEntry =>
  entry({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'ask_user_question', arguments: { questions } }],
  });

export const question = (
  options: readonly unknown[],
  overrides: QuestionOverrides = {},
): QuestionFixture => ({
  question: 'Cancel the ticket?',
  kind: 'approval',
  options,
  ...overrides,
});

export const cancelOption = (preview: string): { label: string; preview: string } => ({
  label: 'Cancel it',
  preview,
});

export const answer = { question: 'Cancel the ticket?', selected: ['Cancel it'], typed: false };

export const askResult = (
  toolCallId: string,
  answers: readonly unknown[],
  overrides: Record<string, unknown> = {},
): SessionEntry =>
  entry({
    role: 'toolResult',
    toolName: 'ask_user_question',
    toolCallId,
    isError: false,
    details: { kind: 'answered', answers },
    ...overrides,
  });
