import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { CustomEditor, SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  ExtensionUIContext,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import type { EditorComponent, TUI } from '@earendil-works/pi-tui';
import type { TestContext } from 'vitest';
import { expect, it, vi } from 'vitest';

import { loadSnippets } from '../src/extensions/snippets/snippet.js';
import { createPiSession } from './piSession.js';

type RegisterCleanup = TestContext['onTestFinished'];

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext['getEditorComponent']>>;

interface HarnessOptions {
  previousFactory?: EditorFactory;
  sessionManager?: (directory: string) => SessionManager;
  sessionStartReason?: SessionStartEvent['reason'];
  /** Runs on the editor that is active before the extension replaces it. */
  beforeBind?: (editor: EditorComponent, session: AgentSession) => void;
}

interface ModelContext {
  messages: { role: string; content: unknown }[];
}

// Real Pi sessions need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

const tauExtensionPath = resolve(import.meta.dirname, '../src/tau.ts');
const shippedSnippets = resolve(import.meta.dirname, '../src/extensions/snippets/snippets');
const historyPrevious = '\u001B[A';

const interviewBody = async () => {
  const snippets = await loadSnippets(shippedSnippets);
  const interview = snippets.find((snippet) => snippet.id === 'interview-me');

  if (interview === undefined) {
    throw new Error('The shipped interview-me snippet is missing.');
  }

  return interview.body;
};

// A custom UI context makes Pi report hasUI=true. Like Pi, it assigns onChange
// after the extension's factory returns.
const createScriptedUI = (previousFactory: EditorFactory | undefined) => {
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
  const changes: string[] = [];

  const assignCallbacks = () => {
    editor.onChange = (text) => {
      changes.push(text);
    };
  };

  assignCallbacks();

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
      assignCallbacks();
    },
    addAutocompleteProvider: () => {},
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
    widgets,
    changes,
    editor: () => editor,
    press: (key: string) => {
      editor.handleInput(key);
    },
  };
};

const createHarness = async (registerCleanup: RegisterCleanup, options: HarnessOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-snippet-flow-'));
  const agentDirectory = await mkdtemp(join(tmpdir(), 'tau-snippet-agent-'));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));
  registerCleanup(() => rm(agentDirectory, { recursive: true, force: true }));

  const faux = fauxProvider({ provider: 'tau-snippet-test' });

  const { session, extensionsResult } = await createPiSession(registerCleanup, {
    cwd: directory,
    agentDirectory,
    providers: [faux],
    // These tests send no tool calls; the list only has to be valid.
    tools: ['read'],
    extensionPaths: [tauExtensionPath],
    ...(options.sessionManager === undefined
      ? {}
      : { sessionManager: options.sessionManager(directory) }),
    ...(options.sessionStartReason === undefined
      ? {}
      : { sessionStartEvent: { type: 'session_start', reason: options.sessionStartReason } }),
  });

  expect(extensionsResult.errors).toEqual([]);

  const scripted = createScriptedUI(options.previousFactory);

  options.beforeBind?.(scripted.editor(), session);

  await session.bindExtensions({ uiContext: scripted.uiContext, mode: 'tui' });

  return { session, faux, ...scripted };
};

/** Text of the newest user message, which is what the snippet extension transforms. */
const promptTextOf = (context: ModelContext) => {
  const user = context.messages.findLast((message) => message.role === 'user');

  if (!Array.isArray(user?.content)) {
    throw new TypeError(`No user message with content blocks: ${JSON.stringify(context.messages)}`);
  }

  return (user.content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
};

const recordReplies = (faux: ReturnType<typeof fauxProvider>, count: number) => {
  const contexts: ModelContext[] = [];

  const record = (context: ModelContext) => {
    contexts.push(context);

    return fauxAssistantMessage('Done.');
  };

  faux.setResponses(Array.from({ length: count }, () => record));

  return contexts;
};

it('sends the snippet bodies of typed tokens and nothing else to the model', async ({
  onTestFinished,
}) => {
  const { session, faux } = await createHarness(onTestFinished);
  const contexts = recordReplies(faux, 2);

  await session.prompt('Add the retry policy #interview-me and keep it short.');
  await session.prompt('Now ship it.');

  expect(contexts.map(promptTextOf)).toEqual([
    `Add the retry policy\n\n${await interviewBody()}\n\nand keep it short.`,
    'Now ship it.',
  ]);

  // The history record is saved in the session but reaches no model request.
  expect(contexts[0]?.messages.map((message) => message.role)).toEqual(['system', 'user']);

  expect(session.sessionManager.getEntries()).toContainEqual(
    expect.objectContaining({ type: 'custom', customType: 'snippet-history' }),
  );
});

it('sends a slash command with its tokens as plain text', async ({ onTestFinished }) => {
  const { session, faux } = await createHarness(onTestFinished);
  const contexts = recordReplies(faux, 1);

  // Pi expands /skill: and prompt templates only at the start of the text.
  await session.prompt('/skill:commit #interview-me');

  expect(contexts.map(promptTextOf)).toEqual(['/skill:commit #interview-me']);
});

it('shows the snippets of the editor text and passes changes on to Pi', async ({
  onTestFinished,
}) => {
  const { uiContext, widgets, changes } = await createHarness(onTestFinished);

  uiContext.setEditorText('#interview-me Add the retry policy.');

  expect(widgets.get('prompt-snippets')).toEqual([expect.stringContaining('Interview me')]);
  expect(changes.at(-1)).toBe('#interview-me Add the retry policy.');

  uiContext.setEditorText('Add the retry policy.');

  expect(widgets.get('prompt-snippets')).toBeUndefined();
});

it('passes changes through an earlier editor that wraps onChange', async ({ onTestFinished }) => {
  const seenByEarlierEditor: string[] = [];

  const earlierFactory: EditorFactory = (terminalUI, theme, keybindings) => {
    const editor = new CustomEditor(terminalUI, theme, keybindings);
    let onChange = editor.onChange;

    Object.defineProperty(editor, 'onChange', {
      configurable: true,
      get: () => (text: string) => {
        seenByEarlierEditor.push(text);
        onChange?.(text);
      },
      set: (handler: typeof onChange) => {
        onChange = handler;
      },
    });

    return editor;
  };

  const { uiContext, widgets, changes } = await createHarness(onTestFinished, {
    previousFactory: earlierFactory,
  });

  uiContext.setEditorText('#interview-me Ship it.');

  expect(seenByEarlierEditor.at(-1)).toBe('#interview-me Ship it.');
  expect(changes.at(-1)).toBe('#interview-me Ship it.');
  expect(widgets.get('prompt-snippets')).toEqual([expect.stringContaining('Interview me')]);
});

// Pi's renderInitialMessages adds the text of each user message to history.
const fillHistory = (editor: EditorComponent, session: AgentSession) => {
  for (const message of session.messages) {
    if (message.role === 'user') {
      editor.addToHistory?.(promptTextOf({ messages: [message] }));
    }
  }
};

const createSavedSession = async (registerCleanup: RegisterCleanup) => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), 'tau-snippet-sessions-'));
  registerCleanup(() => rm(sessionDirectory, { recursive: true, force: true }));

  const first = await createHarness(registerCleanup, {
    sessionManager: (cwd) => SessionManager.create(cwd, sessionDirectory),
  });

  recordReplies(first.faux, 2);
  await first.session.prompt('Add the retry policy #interview-me and keep it short.');
  await first.session.prompt('Now ship it.');

  const sessionFile = first.session.sessionManager.getSessionFile();

  if (sessionFile === undefined) {
    throw new Error('The first session saved no file.');
  }

  return () => SessionManager.open(sessionFile, sessionDirectory);
};

const recallHistory = (harness: Awaited<ReturnType<typeof createHarness>>, presses: number) => {
  const recalled: string[] = [];

  for (let press = 0; press < presses; press += 1) {
    harness.press(historyPrevious);
    recalled.push(harness.uiContext.getEditorText());
  }

  return recalled;
};

it('recalls the typed tokens once each when Pi starts on a saved session', async ({
  onTestFinished,
}) => {
  const openSaved = await createSavedSession(onTestFinished);

  const started = await createHarness(onTestFinished, { sessionManager: openSaved });

  // At startup Pi fills history after session_start, into the replacement editor.
  fillHistory(started.editor(), started.session);

  expect(recallHistory(started, 3)).toEqual([
    'Now ship it.',
    'Add the retry policy #interview-me and keep it short.',
    'Add the retry policy #interview-me and keep it short.',
  ]);
});

it.for(['resume', 'fork'] as const)(
  'recalls the typed tokens once each after an in-session %s',
  async (reason, { onTestFinished }) => {
    const openSaved = await createSavedSession(onTestFinished);

    // On /resume and fork, Pi fills the old editor's history before session_start,
    // and the replacement editor does not copy it.
    const switched = await createHarness(onTestFinished, {
      sessionManager: openSaved,
      sessionStartReason: reason,
      beforeBind: fillHistory,
    });

    expect(recallHistory(switched, 3)).toEqual([
      'Now ship it.',
      'Add the retry policy #interview-me and keep it short.',
      'Add the retry policy #interview-me and keep it short.',
    ]);
  },
);
