const arrowSeparatorMajor = 5;

// Chai's default truncateThreshold, which also counts the quotes it adds around a substituted value.
export const chaiDisplayCut = 40;

const quotedNamePadding = 2;

// Vitest 5 joins nested test names with ` > `; earlier versions use a space.
export const nameSeparator = (version: string): string =>
  Number.parseInt(version, 10) >= arrowSeparatorMajor ? ' > ' : ' ';

const escapePattern = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const quoteCharacters = ['"', "'"];

const isQuote = (character: string): boolean => quoteCharacters.includes(character);

// Vitest renders an `it.each` "$name" through chai's display, which wraps each substituted value in
// quotes, so the name it registers differs from the name written in the table. Chai leaves no
// marker for the wrapper, so it may open at any space.
const wrapStarts = (name: string): number[] => {
  const starts = [0];
  let index = name.indexOf(' ');

  while (index >= 0) {
    starts.push(index + 1);
    index = name.indexOf(' ', index + 1);
  }

  return starts.filter((start) => name.length > start);
};

const wrapsAt = (name: string, start: number): boolean => {
  const quote = name.charAt(start);

  return name.length > start + 1 && isQuote(quote) && name.at(-1) === quote;
};

const unwrappedAt = (name: string, start: number): string =>
  name.slice(0, start) + name.slice(start + 1, -1);

export const matchesRequestedName = (registeredName: string, requestedName: string): boolean => {
  if (registeredName === requestedName) {
    return true;
  }

  return wrapStarts(registeredName).some(
    (start) =>
      wrapsAt(registeredName, start) && unwrappedAt(registeredName, start) === requestedName,
  );
};

export const matchesAnyRequestedName = (
  registeredName: string,
  requestedNames: readonly string[],
): boolean => requestedNames.some((name) => matchesRequestedName(registeredName, name));

export const displayCutFor = (requestedNames: readonly string[]): number =>
  Math.max(chaiDisplayCut, ...requestedNames.map((name) => name.length + quotedNamePadding));

const wrappedAlternatives = (name: string): string[] =>
  wrapStarts(name).flatMap((start) => {
    const head = escapePattern(name.slice(0, start));
    const tail = escapePattern(name.slice(start));

    return quoteCharacters.map((quote) => `${head}${quote}${tail}${quote}`);
  });

export const requestedNamePattern = (requestedNames: readonly string[]): string => {
  const alternatives = requestedNames.flatMap((name) => [
    escapePattern(name),
    ...wrappedAlternatives(name),
  ]);

  return `^(?:${alternatives.join('|')})$`;
};
