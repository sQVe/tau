import { createEventBus } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';
import type { Mock } from 'vitest';

type Handler = (event: never, context: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI['registerCommand']>[1];

interface FakeExtensionApi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  handler: (name: string) => (event: unknown, context: ExtensionContext) => unknown;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, Command>;
  messageRenderers: Map<string, MessageRenderer>;
  sendUserMessage: Mock<ExtensionAPI['sendUserMessage']>;
  sendMessage: Mock<ExtensionAPI['sendMessage']>;
}

// Records what an extension registers so a test can drive its handlers without a Pi session.
export const fakeExtensionApi = (overrides: Partial<ExtensionAPI> = {}): FakeExtensionApi => {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Command>();
  const messageRenderers = new Map<string, MessageRenderer>();
  const sendUserMessage = vi.fn<ExtensionAPI['sendUserMessage']>();
  const sendMessage = vi.fn<ExtensionAPI['sendMessage']>();

  const pi = {
    events: createEventBus(),
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerShortcut: () => undefined,
    getCommands: () => [
      { name: 'skill:tdd', source: 'skill', sourceInfo: { path: '/skills/tdd/SKILL.md' } },
    ],
    registerMessageRenderer: (customType: string, renderer: MessageRenderer) => {
      messageRenderers.set(customType, renderer);
    },
    sendUserMessage,
    sendMessage,
    ...overrides,
  } as unknown as ExtensionAPI;

  const handler = (name: string) => {
    const registered = handlers.get(name) ?? [];

    if (registered.length !== 1) {
      throw new Error(`Expected one ${name} handler, found ${registered.length}.`);
    }

    return registered[0] as unknown as (event: unknown, context: ExtensionContext) => unknown;
  };

  return { pi, handlers, handler, tools, commands, messageRenderers, sendUserMessage, sendMessage };
};

export const appendedSystemPrompt = (
  handlers: Map<string, Handler[]>,
  selectedTools: string[],
  context = {} as ExtensionContext,
): string => {
  const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools } };

  for (const handler of handlers.get('before_agent_start') ?? []) {
    handler(event as never, context);
  }

  return event.systemPromptOptions.appendSystemPrompt;
};
