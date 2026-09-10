import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { expect, it, vi } from 'vitest';

// Real Pi sessions need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

type RegisterCleanup = TestContext['onTestFinished'];

const tauExtensionsPath = resolve(import.meta.dirname, '../src/extensions');

/**
 * A custom UI context makes Pi report hasUI=true. Render the menu once before
 * sending the scripted keys so the test follows the terminal input order.
 */
const createScriptedUI = (overlays: string[], keys: string[]): ExtensionUIContext => {
  const widgets = new Map<string, string[] | undefined>();
  const target: Record<string | symbol, unknown> = {
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    setWidget: (key: string, content: string[] | undefined) => {
      widgets.set(key, content);
    },
    notify: () => {},
    custom: async (factory: Parameters<ExtensionUIContext['custom']>[0]) => {
      let result: boolean | undefined;
      const component = await factory(
        { requestRender: () => {}, terminal: { rows: 60 } } as never,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
        {} as never,
        (value) => {
          result = value as boolean;
        },
      );

      overlays.push(component.render(80).join('\n'));

      for (const key of keys) {
        component.handleInput?.(key);
      }

      return result;
    },
  };

  const scriptedUI = new Proxy(target, {
    get: (object, property) => {
      if (property in object) {
        return object[property];
      }

      throw new Error(`Scripted UI has no ${String(property)}`);
    },
  });

  return scriptedUI as unknown as ExtensionUIContext;
};

const createHarness = async (registerCleanup: RegisterCleanup, keys: string[]) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-snippet-flow-'));
  const agentDirectory = await mkdtemp(join(tmpdir(), 'tau-snippet-agent-'));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));
  registerCleanup(() => rm(agentDirectory, { recursive: true, force: true }));

  const faux = fauxProvider({ provider: 'tau-snippet-test' });

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: agentDirectory,
    settingsManager,
    additionalExtensionPaths: [tauExtensionsPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });

  await loader.reload();

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const { session, extensionsResult } = await createAgentSession({
    cwd: directory,
    agentDir: agentDirectory,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(directory),
    settingsManager,
    // These tests send no tool calls; the list only has to be valid.
    tools: ['read'],
  });
  registerCleanup(() => {
    session.dispose();
  });

  expect(extensionsResult.errors).toEqual([]);

  const overlays: string[] = [];

  // The menu is a terminal component, so it only runs when the mode is "tui".
  await session.bindExtensions({ uiContext: createScriptedUI(overlays, keys), mode: 'tui' });

  const commandNames = extensionsResult.extensions.flatMap((extension) =>
    Array.from(extension.commands.keys()),
  );

  return { session, faux, overlays, commandNames };
};

/** Text of the newest user message, which is what the snippet extension transforms. */
const promptTextOf = (context: { messages: { role: string; content: unknown }[] }) => {
  const user = context.messages.findLast((message) => message.role === 'user');
  if (!Array.isArray(user?.content)) {
    throw new TypeError(`No user message with content blocks: ${JSON.stringify(context.messages)}`);
  }

  return (user.content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
};

it('registers the snippets command in a real Pi session', async ({ onTestFinished }) => {
  const { commandNames } = await createHarness(onTestFinished, []);

  expect(commandNames).toContain('snippets');
});

it('prepends a toggled snippet to the next message and then resets', async ({ onTestFinished }) => {
  // The cursor starts on the first prepend snippet, so space toggles it.
  const { session, faux, overlays } = await createHarness(onTestFinished, [' ', '\r']);

  await session.prompt('/snippets');

  expect(overlays).toHaveLength(1);
  expect(overlays[0]).toContain('Interview me');
  expect(overlays[0]).toContain('Prompt snippets');

  const sent: string[] = [];
  faux.setResponses([
    (context) => {
      sent.push(promptTextOf(context));

      return fauxAssistantMessage('Understood.');
    },
    (context) => {
      sent.push(promptTextOf(context));

      return fauxAssistantMessage('Done.');
    },
  ]);

  await session.prompt('Add the retry policy.');
  await session.prompt('Now ship it.');

  expect(sent[0]).toMatch(/^Interview me before you start\./);
  expect(sent[0]).toMatch(/until I say we agree\.\n\nAdd the retry policy\.$/);
  expect(sent[1]).toBe('Now ship it.');
});

it('keeps a slash command at the start of the text and keeps the toggle on', async ({
  onTestFinished,
}) => {
  const { session, faux } = await createHarness(onTestFinished, [' ', '\r']);

  await session.prompt('/snippets');

  const sent: string[] = [];
  const record = (context: Parameters<typeof promptTextOf>[0]) => {
    sent.push(promptTextOf(context));

    return fauxAssistantMessage('Done.');
  };

  faux.setResponses([record, record]);

  // Pi expands /skill: and prompt templates only at the start of the text.
  await session.prompt('/skill:commit');
  await session.prompt('Add the retry policy.');

  expect(sent[0]).toBe('/skill:commit');
  expect(sent[1]).toMatch(/^Interview me before you start\./);
});

it('leaves the message unchanged when the user cancels the menu', async ({ onTestFinished }) => {
  const { session, faux } = await createHarness(onTestFinished, [' ', '']);

  await session.prompt('/snippets');

  const sent: string[] = [];
  faux.setResponses([
    (context) => {
      sent.push(promptTextOf(context));

      return fauxAssistantMessage('Done.');
    },
  ]);

  await session.prompt('Add the retry policy.');

  expect(sent[0]).toBe('Add the retry policy.');
});
