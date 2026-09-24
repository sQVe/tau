import { createEventBus } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';

type Handler = (event: never, context: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI['registerCommand']>[1];

// Records what an extension registers so a test can drive its handlers without a Pi session.
export const fakeExtensionApi = (overrides: Partial<ExtensionAPI> = {}) => {
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
