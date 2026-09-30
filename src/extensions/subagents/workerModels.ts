// Profile names mapped to `provider/id` references, from the user file's `profiles` block.
export type ProfileModels = ReadonlyMap<string, string>;

export const defaultProfileName = 'default';

// A launch model wins, then the profile's entry, then the `default` entry. Tau names no model of its
// own, so without any of them the result is undefined.
export const selectWorkerModel = (
  launchModel: string | undefined,
  profile: string,
  profiles: ProfileModels,
): string | undefined => launchModel ?? profiles.get(profile) ?? profiles.get(defaultProfileName);

export const availableModels = (
  scoped: readonly string[],
  allowed: readonly string[] | undefined,
): string[] =>
  allowed === undefined ? [...scoped] : scoped.filter((model) => allowed.includes(model));

// Lists each available model once, then each profile default outside that list. A profile without a
// default is left out, and without any model there is no line. A profile file named `default` is
// refused at launch, so it gets no mark.
export const workerModelLine = (
  available: readonly string[],
  profileNames: readonly string[],
  profiles: ProfileModels,
): string | undefined => {
  const defaults = new Map(available.map((model) => [model, [] as string[]]));

  const launchable = profileNames.filter((name) => name !== defaultProfileName);

  for (const name of launchable) {
    const model = selectWorkerModel(undefined, name, profiles);

    if (model === undefined) {
      continue;
    }

    defaults.set(model, [...(defaults.get(model) ?? []), name]);
  }

  const entries = [...defaults].map(([model, names]) =>
    names.length === 0 ? model : `${model} (${names.join(', ')})`,
  );

  if (entries.length === 0) {
    return undefined;
  }

  return `Models, with the profiles that default to each: ${entries.join(', ')}.`;
};
