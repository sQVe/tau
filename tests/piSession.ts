import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import type { FauxProviderHandle } from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

interface PiSessionOptions {
  cwd: string;
  agentDirectory: string;
  /** The first provider supplies the session model. */
  providers: [FauxProviderHandle, ...FauxProviderHandle[]];
  tools: string[];
  extensionPaths?: string[];
  skillPaths?: string[];
  extensionFactories?: NonNullable<LoaderOptions['extensionFactories']>;
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
}

// A real Pi session on faux providers that loads only the named extensions and skills. The caller
// binds extensions, because the UI context differs per test.
export const createPiSession = async (
  registerCleanup: TestContext['onTestFinished'],
  options: PiSessionOptions,
) => {
  const { cwd, agentDirectory, providers } = options;
  const settingsManager = SettingsManager.inMemory(
    options.settings ?? { compaction: { enabled: false } },
  );

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    settingsManager,
    additionalExtensionPaths: options.extensionPaths ?? [],
    additionalSkillPaths: options.skillPaths ?? [],
    extensionFactories: options.extensionFactories ?? [],
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

  for (const provider of providers) {
    modelRuntime.registerNativeProvider(provider.provider);
  }

  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir: agentDirectory,
    modelRuntime,
    model: providers[0].getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: options.tools,
  });
  registerCleanup(() => {
    session.dispose();
  });

  return { session, extensionsResult };
};

type BindOptions = Parameters<
  Awaited<ReturnType<typeof createPiSession>>['session']['bindExtensions']
>[0];

// Most tests bind right away; a failed extension load stops the test before any prompt runs.
export const createBoundSession = async (
  registerCleanup: TestContext['onTestFinished'],
  options: PiSessionOptions,
  bindOptions: BindOptions = {},
) => {
  const created = await createPiSession(registerCleanup, options);

  if (created.extensionsResult.errors.length > 0) {
    throw new Error(
      `Extensions failed to load: ${JSON.stringify(created.extensionsResult.errors)}`,
    );
  }

  await created.session.bindExtensions(bindOptions);

  return created;
};
