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
  CustomEditor,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import type { EditorComponent, TUI } from '@earendil-works/pi-tui';
import type { TestContext } from 'vitest';
import { expect, it, vi } from 'vitest';

// Real Pi sessions need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

type RegisterCleanup = TestContext['onTestFinished'];
type EditorFactory = NonNullable<ReturnType<ExtensionUIContext['getEditorComponent']>>;

const tauExtensionsPath = resolve(import.meta.dirname, '../src/extensions');

/**
 * A custom UI context makes Pi report hasUI=true. Render the menu once before
 * sending the scripted keys so the test follows the terminal input order.
 */
const createScriptedUI = (
  overlays: string[],
  keys: string[],
  submit: (text: string) => void,
  previousFactory: EditorFactory | undefined,
) => {
  const keybindings = new KeybindingsManager(
    TUI_KEYBINDINGS,
  ) as unknown as Parameters<EditorFactory>[2];
  const terminalUI = {
    requestRender: () => {},
    getKeybindings: () => keybindings,
  } as unknown as TUI;
  const editorTheme = {
    borderColor: (text: string) => text,
    selectList: {},
  } as Parameters<EditorFactory>[1];
  let editor: EditorComponent = new CustomEditor(terminalUI, editorTheme, keybindings);
  let editorFactory = previousFactory;
  editor.onSubmit = submit;

  const widgets = new Map<string, string[] | undefined>();
  const target: Record<string | symbol, unknown> = {
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    setWidget: (key: string, content: string[] | undefined) => {
      widgets.set(key, content);
    },
    notify: () => {},
    getEditorText: () => editor.getText(),
    setEditorText: (text: string) => {
      editor.setText(text);
    },
    getEditorComponent: () => editorFactory,
    setEditorComponent: (factory: EditorFactory) => {
      editorFactory = factory;
      editor = factory(terminalUI, editorTheme, keybindings);
      editor.onSubmit = submit;
    },
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

  return {
    uiContext: scriptedUI as unknown as ExtensionUIContext,
    press: (key: string) => {
      editor.handleInput(key);
    },
  };
};

const createHarness = async (
  registerCleanup: RegisterCleanup,
  keys: string[],
  previousFactory?: EditorFactory,
) => {
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

  const submissions: Promise<void>[] = [];
  const { uiContext, press } = createScriptedUI(
    overlays,
    keys,
    (text) => {
      // Mirror Pi's blank-input guard so the harness does not send text the terminal would drop.
      if (text.trim() !== '') {
        submissions.push(session.prompt(text, { streamingBehavior: 'steer' }));
      }
    },
    previousFactory,
  );
  await session.bindExtensions({ uiContext, mode: 'tui' });

  const commandNames = extensionsResult.extensions.flatMap((extension) =>
    Array.from(extension.commands.keys()),
  );

  return { session, faux, overlays, commandNames, uiContext, press, submissions };
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

  expect(sent[0]).not.toMatch(/\n$/);
  expect(sent[0]).toMatch(/until I approve the agreed scope\.\n\nAdd the retry policy\.$/);
  expect(sent[1]).toBe('Now ship it.');
});

it('sends selected snippets on empty Enter and resets the toggles', async ({ onTestFinished }) => {
  const { session, faux, uiContext, press, submissions } = await createHarness(onTestFinished, [
    ' ',
    '\r',
  ]);

  await session.prompt('/snippets');

  expect(uiContext.getEditorComponent()).toBeTypeOf('function');

  const sent: string[] = [];
  const finished = new Promise<void>((complete) => {
    session.subscribe((event) => {
      if (event.type === 'agent_settled') {
        complete();
      }
    });
  });
  faux.setResponses([
    (context) => {
      sent.push(promptTextOf(context));

      return fauxAssistantMessage('Done.');
    },
  ]);

  press('\r');
  await finished;

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/^Interview me before you start\./);
  expect(sent[0]).not.toMatch(/\n$/);
  expect(uiContext.getEditorText()).toBe('');

  press('\r');
  expect(submissions).toHaveLength(0);

  uiContext.setEditorText('Now ship it.');
  press('\r');

  expect(submissions).toHaveLength(1);
  await submissions[0];

  const userMessages = session.messages.filter((message) => message.role === 'user');

  expect(userMessages).toHaveLength(2);
  expect(userMessages[1]?.content).toEqual([{ type: 'text', text: 'Now ship it.' }]);
});

it('passes submissions through an earlier editor that wraps onSubmit', async ({
  onTestFinished,
}) => {
  const seenByEarlierEditor: string[] = [];
  const earlierFactory: EditorFactory = (terminalUI, theme, keybindings) => {
    const editor = new CustomEditor(terminalUI, theme, keybindings);
    let onSubmit = editor.onSubmit;

    Object.defineProperty(editor, 'onSubmit', {
      configurable: true,
      get: () => (text: string) => {
        seenByEarlierEditor.push(text);
        onSubmit?.(text);
      },
      set: (handler: typeof onSubmit) => {
        onSubmit = handler;
      },
    });

    return editor;
  };
  const { uiContext, press, submissions } = await createHarness(onTestFinished, [], earlierFactory);

  uiContext.setEditorText('Ship it.');
  press('\r');

  expect(seenByEarlierEditor).toEqual(['Ship it.']);
  expect(submissions).toHaveLength(1);
  await submissions[0];
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
