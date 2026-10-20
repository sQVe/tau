export type AdrIndexMark = { mark: string } | { problem: string };

const metadataField = /^\*\*([^*\n]+)\*\*:([\s\S]*)$/;
const adrMention = /ADR (\d{4})/g;

const collapsedSpace = (text: string) => text.replaceAll(/\s+/g, ' ').trim();

// The metadata is the paragraph after the heading, with one field per backslash-ended line.
const metadataOf = (markdown: string) => {
  const [, paragraph = ''] = markdown.split('\n\n');
  const fields = new Map<string, string>();

  for (const line of paragraph.split('\\\n')) {
    const [, name, value = ''] = metadataField.exec(line) ?? [];

    if (name !== undefined) {
      fields.set(name, collapsedSpace(value));
    }
  }

  return fields;
};

const mentionedAdrs = (text: string) => [
  ...new Set([...text.matchAll(adrMention)].map((match) => match[1] ?? '')),
];

const listed = (numbers: readonly string[]) => {
  const first = numbers.slice(0, -1);
  const last = numbers.at(-1) ?? '';

  if (first.length === 0) {
    return last;
  }

  const separator = first.length > 1 ? ', and ' : ' and ';

  return `${first.join(', ')}${separator}${last}`;
};

const markNaming = (kind: string, numbers: readonly string[]): AdrIndexMark =>
  numbers.length === 0
    ? { problem: `is ${kind} but names no ADR` }
    : { mark: `, ${kind} by ${listed(numbers)}` };

// Until the superseded chains merge, an index line names the ADRs that its status says replace it
// in whole or in part. Accepted is the only status for a current ADR; Superseded and an Accepted
// status that names superseded parts remain only on older ADRs.
export const adrIndexMark = (markdown: string): AdrIndexMark => {
  const metadata = metadataOf(markdown);
  const status = metadata.get('Status');

  if (status === undefined) {
    return { problem: 'has no Status line' };
  }

  if (status === 'Accepted') {
    return { mark: '' };
  }

  if (status === 'Superseded') {
    return markNaming('superseded', mentionedAdrs(metadata.get('Superseded by') ?? ''));
  }

  if (status.startsWith('Accepted; ')) {
    return markNaming('partly superseded', mentionedAdrs(status));
  }

  return { problem: `has unknown status "${status}"` };
};
