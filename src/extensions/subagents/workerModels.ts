// Profile names mapped to `provider/id` references, from the user file's `profiles` block.
export type ProfileModels = ReadonlyMap<string, string>;

export const defaultProfileName = 'default';

const builtInWorkerModel = 'claude-bridge/claude-opus-5-5';

// A launch model wins, then the profile's entry, then the `default` entry, then the built-in model.
export const selectWorkerModel = (
  launchModel: string | undefined,
  profile: string,
  profiles: ProfileModels,
): string =>
  launchModel ?? profiles.get(profile) ?? profiles.get(defaultProfileName) ?? builtInWorkerModel;

// Without an allowed list, every scoped model is available.
export const availableModels = (
  scoped: readonly string[],
  allowed: readonly string[] | undefined,
): string[] =>
  allowed === undefined ? [...scoped] : scoped.filter((model) => allowed.includes(model));

// Lists each available model once, then each profile default outside that list.
export const workerModelLine = (
  available: readonly string[],
  profileNames: readonly string[],
  profiles: ProfileModels,
): string => {
  const defaults = new Map(available.map((model) => [model, [] as string[]]));

  for (const name of profileNames) {
    const model = selectWorkerModel(undefined, name, profiles);

    defaults.set(model, [...(defaults.get(model) ?? []), name]);
  }

  const entries = [...defaults].map(([model, names]) =>
    names.length === 0 ? model : `${model} (${names.join(', ')})`,
  );

  return `Models, with the profiles that default to each: ${entries.join(', ')}.`;
};
