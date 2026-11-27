import { createEventBus } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { onTestFinished, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { RoleKind } from '../src/role/role.js';
import tauRegistration from '../src/tau/tau.js';
import { declinedExec } from './declinedExecFake.js';

type Handler = (event: never, context: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI['registerCommand']>[1];

export interface FakeExtensionApi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  handler: (name: string) => (event: unknown, context: ExtensionContext) => unknown;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, Command>;
  messageRenderers: Map<string, MessageRenderer>;
  sendUserMessage: Mock<ExtensionAPI['sendUserMessage']>;
  sendMessage: Mock<ExtensionAPI['sendMessage']>;
}

export interface FakeExtensionContextOptions {
  branch?: readonly unknown[];
  entries?: readonly unknown[];
  sessionId?: string;
  cwd?: string;
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
      {
        name: 'skill:benchmark-checklist',
        source: 'skill',
        sourceInfo: { path: '/skills/benchmark-checklist/SKILL.md' },
      },
    ],
    registerMessageRenderer: (customType: string, renderer: MessageRenderer) => {
      messageRenderers.set(customType, renderer);
    },
    registerVirtualModel: vi.fn<ExtensionAPI['registerVirtualModel']>(),
    sendUserMessage,
    sendMessage,
    exec: declinedExec,
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

// Builds only the context fields an extension reads from cwd and the session manager.
export const fakeExtensionContext = (options: FakeExtensionContextOptions = {}): ExtensionContext =>
  ({
    cwd: options.cwd ?? '/repository',
    sessionManager: {
      getBranch: () => options.branch ?? [],
      getEntries: () => options.entries ?? [],
      getSessionId: () => options.sessionId ?? 'session-1',
    },
  }) as unknown as ExtensionContext;

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

// Registers Tau for a role so a test can inspect what the entry point wires.
export const registeredTauApi = async (role: RoleKind): Promise<FakeExtensionApi> => {
  const roleVariable = role === 'lead' ? undefined : role;

  vi.stubEnv('TAU_ROLE', roleVariable);

  // A registered handler reads the role when the test invokes it, so the stub must outlive this
  // helper instead of being cleared before it returns.
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const fake = fakeExtensionApi();

  await tauRegistration(fake.pi);

  return fake;
};
