// A long option matches exactly or with `=value`. A short option also matches with its value
// attached, as getopt reads `-command` as `-c` with the value `ommand`.
export const matchesOption = (word: string, option: string): boolean =>
  option.startsWith('--')
    ? word === option || word.startsWith(`${option}=`)
    : word.startsWith(option);

// In a short-option cluster such as `-Eu`, a value-taking letter takes the rest of the word or,
// when it is last, the next word.
const clusterValue = (
  words: readonly string[],
  index: number,
  word: string,
  options: ReadonlySet<string>,
): { value: string; next: number } | undefined => {
  if (!/^-[A-Za-z]{2,}$/u.test(word)) {
    return undefined;
  }

  const letters = word.slice(1);

  for (let position = 0; position < letters.length; position += 1) {
    const letter = letters[position] ?? '';

    if (!options.has(`-${letter}`)) {
      continue;
    }

    const attached = letters.slice(position + 1);

    if (attached !== '') {
      return { value: attached, next: index + 1 };
    }

    const value = words[index + 1];

    return value === undefined ? undefined : { value, next: index + 2 };
  }

  return undefined;
};

// getopt_long accepts any unambiguous abbreviation of a long option, so `--split` names
// `--split-string`.
const abbreviatedLongOption = (word: string, options: ReadonlySet<string>): string | undefined => {
  if (!word.startsWith('--') || word === '--') {
    return undefined;
  }

  const equals = word.indexOf('=');
  const name = equals === -1 ? word : word.slice(0, equals);

  const candidates = [...options].filter(
    (option) => option.startsWith('--') && option.startsWith(name),
  );

  return candidates.length === 1 ? candidates[0] : undefined;
};

// A value option takes the next word, an attached value, or a short-option cluster's value.
export const optionValue = (
  words: readonly string[],
  index: number,
  options: ReadonlySet<string>,
): { value: string; next: number } | undefined => {
  const word = words[index] ?? '';

  for (const option of options) {
    if (!matchesOption(word, option)) {
      continue;
    }

    if (word === option) {
      const value = words[index + 1];

      return value === undefined ? undefined : { value, next: index + 2 };
    }

    const attached = word.slice(option.length);
    const value = attached.startsWith('=') ? attached.slice(1) : attached;

    return { value, next: index + 1 };
  }

  const abbreviated = abbreviatedLongOption(word, options);

  const equals = word.indexOf('=');

  if (abbreviated !== undefined && equals !== -1) {
    return { value: word.slice(equals + 1), next: index + 1 };
  }

  if (abbreviated !== undefined) {
    const value = words[index + 1];

    return value === undefined ? undefined : { value, next: index + 2 };
  }

  return clusterValue(words, index, word, options);
};
