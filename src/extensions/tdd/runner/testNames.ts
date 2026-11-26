const arrowSeparatorMajor = 5;

// Vitest 5 joins nested test names with ` > `; earlier versions use a space.
export const nameSeparator = (version: string): string =>
  Number.parseInt(version, 10) >= arrowSeparatorMajor ? ' > ' : ' ';

const escapePattern = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const quoteCharacters = ['"', "'"];

const isQuote = (character: string): boolean => quoteCharacters.includes(character);

// Vitest renders an `it.each` "$name" through chai's display, which wraps the value in quotes, so
// the name it registers differs from the name written in the table.
const openingQuoteIndex = (registeredName: string): number => {
  const closing = registeredName.at(-1) ?? '';

  return isQuote(closing) ? registeredName.lastIndexOf(closing, registeredName.length - 2) : -1;
};

export const matchesRequestedName = (registeredName: string, requestedName: string): boolean => {
  if (registeredName === requestedName) {
    return true;
  }

  const opening = openingQuoteIndex(registeredName);

  if (opening < 0) {
    return false;
  }

  const unwrapped = registeredName.slice(0, opening) + registeredName.slice(opening + 1, -1);

  return unwrapped === requestedName;
};

// The wrapper opens at the start of the last segment, so every segment boundary is a candidate.
const segmentStarts = (name: string, separator: string): number[] => {
  const starts = [0];
  let index = name.indexOf(separator);

  while (index >= 0) {
    starts.push(index + separator.length);
    index = name.indexOf(separator, index + separator.length);
  }

  return starts;
};

const wrappedAlternatives = (name: string, separator: string): string[] =>
  segmentStarts(name, separator).flatMap((start) => {
    const head = escapePattern(name.slice(0, start));
    const tail = escapePattern(name.slice(start));

    return quoteCharacters.map((quote) => `${head}${quote}${tail}${quote}`);
  });

export const requestedNamePattern = (
  requestedNames: readonly string[],
  separator: string,
): string => {
  const alternatives = requestedNames.flatMap((name) => [
    escapePattern(name),
    ...wrappedAlternatives(name, separator),
  ]);

  return `^(?:${alternatives.join('|')})$`;
};
