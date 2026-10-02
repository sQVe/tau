import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { CustomEditor, SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  AutocompleteProviderFactory,
  ExtensionUIContext,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import {
  CombinedAutocompleteProvider,
  KeybindingsManager,
  TUI_KEYBINDINGS,
} from '@earendil-works/pi-tui';
import type { AutocompleteProvider, EditorComponent, TUI } from '@earendil-works/pi-tui';
import type { TestContext } from 'vitest';
import { expect, it, vi } from 'vitest';

import { loadSnippets } from '../src/extensions/snippets/snippet.js';
import { createPiSession } from './piSession.js';

type RegisterCleanup = TestContext['onTestFinished'];

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext['getEditorComponent']>>;

interface HarnessOptions {
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
const enter = '\r';
const historyPrevious = '\u001B[A';

const interviewBody = async () => {
  const snippets = await loadSnippets(shippedSnippets);
  const interview = snippets.find((snippet) => snippet.id === 'interview-me');

  if (interview === undefined) {
    throw new Error('The shipped interview-me snippet is missing.');
  }

  return interview.body;
};

// A custom UI context makes Pi report hasUI=true. Like Pi's interactive mode, it wraps the base
// autocomplete provider with each added factory, and a submit adds the text to history before
// sending it. A replacement editor gets the text, callbacks, and autocomplete of the old one, but
// not its history.
const createScriptedUI = (session: AgentSession, cwd: string) => {
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
  let editorFactory: EditorFactory | undefined;
  const sent: Promise<void>[] = [];
  let provider: AutocompleteProvider = new CombinedAutocompleteProvider([], cwd);

  const submit = (text: string) => {
    editor.addToHistory?.(text);
    sent.push(session.prompt(text));
  };

  editor.onSubmit = submit;

  const target: Record<string | symbol, unknown> = {
    notify: () => {},
    setWidget: () => {},
    getEditorText: () => editor.getText(),
    setEditorText: (text: string) => {
      editor.setText(text);
    },
    getEditorComponent: () => editorFactory,
    setEditorComponent: (factory: EditorFactory) => {
      const replacement = factory(terminalUI, editorTheme, keybindings);

      replacement.onSubmit = submit;
      replacement.setText(editor.getText());
      replacement.setAutocompleteProvider?.(provider);
      editorFactory = factory;
      editor = replacement;
    },
    addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
      provider = factory(provider);
      editor.setAutocompleteProvider?.(provider);
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
    editor: () => editor,
    isShowingAutocomplete: () => (editor as CustomEditor).isShowingAutocomplete(),
    sent,
    type: (text: string) => {
      for (const character of text) {
        editor.handleInput(character);
      }
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

  const scripted = createScriptedUI(session, directory);

  options.beforeBind?.(scripted.editor(), session);

  await session.bindExtensions({ uiContext: scripted.uiContext, mode: 'tui' });

  return { session, faux, ...scripted };
};

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

it('sends exactly the editor text after a snippet is picked and recalls it from history', async ({
  onTestFinished,
}) => {
  const harness = await createHarness(onTestFinished);
  const contexts = recordReplies(harness.faux, 1);
  const shown = `Add the retry policy\n\n${await interviewBody()}`;

  harness.type('Add the retry policy #interview');

  await vi.waitFor(() => {
    expect(harness.isShowingAutocomplete()).toBe(true);
  });

  harness.editor().handleInput(enter);

  expect(harness.editor().getText()).toBe(shown);

  harness.editor().handleInput(enter);
  await Promise.all(harness.sent);

  expect(contexts.map(promptTextOf)).toEqual([shown]);

  harness.editor().handleInput(historyPrevious);

  expect(harness.editor().getText()).toBe(shown);
});

it('sends a typed snippet id as plain text', async ({ onTestFinished }) => {
  const { session, faux } = await createHarness(onTestFinished);
  const contexts = recordReplies(faux, 1);

  await session.prompt('Add the retry policy #interview-me');

  expect(contexts.map(promptTextOf)).toEqual(['Add the retry policy #interview-me']);
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
  await first.session.prompt('Add the retry policy');
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
    harness.editor().handleInput(historyPrevious);
    recalled.push(harness.editor().getText());
  }

  return recalled;
};

it('recalls each sent message once when Pi starts on a saved session', async ({
  onTestFinished,
}) => {
  const openSaved = await createSavedSession(onTestFinished);
  const started = await createHarness(onTestFinished, { sessionManager: openSaved });

  // At startup Pi fills history after session_start, into the replacement editor.
  fillHistory(started.editor(), started.session);

  expect(recallHistory(started, 3)).toEqual([
    'Now ship it.',
    'Add the retry policy',
    'Add the retry policy',
  ]);
});

it.for(['resume', 'fork', 'reload'] as const)(
  'recalls each sent message once after %s',
  async (reason, { onTestFinished }) => {
    const openSaved = await createSavedSession(onTestFinished);

    // On these reasons Pi fills the old editor's history before session_start, and the
    // replacement editor does not copy it.
    const switched = await createHarness(onTestFinished, {
      sessionManager: openSaved,
      sessionStartReason: reason,
      beforeBind: fillHistory,
    });

    expect(recallHistory(switched, 3)).toEqual([
      'Now ship it.',
      'Add the retry policy',
      'Add the retry policy',
    ]);
  },
);
