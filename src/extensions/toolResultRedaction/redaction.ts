import type { ToolResultEvent, ToolResultEventResult } from '@earendil-works/pi-coding-agent';

interface Redaction {
  secrets: readonly string[];
  visited: WeakSet<object>;
  changed: boolean;
}

type StructuredContent = NonNullable<ToolResultEventResult['structuredContent']>;

type ContentItem = ToolResultEvent['content'][number];

interface ToolResultFacts {
  content: ToolResultEvent['content'];
  details: unknown;
  structuredContent?: unknown;
}

const redactionMarker = '[redacted]';
const minimumSecretLength = 8;
const secretSuffixes = new Set(['KEY', 'APIKEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD']);
const secretNames = new Set(['AWS_BEARER_TOKEN_BEDROCK']);

export const isSecretName = (name: string): boolean => {
  const upper = name.toUpperCase();
  const suffix = upper.slice(upper.lastIndexOf('_') + 1);

  return secretSuffixes.has(suffix) || secretNames.has(upper);
};

const jsonEscaped = (value: string): string => JSON.stringify(value).slice(1, -1);

export const secretValues = (
  environment: Readonly<Record<string, string | undefined>>,
): string[] => {
  const values = new Set<string>();

  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && value.length >= minimumSecretLength && isSecretName(name)) {
      values.add(value);
      values.add(jsonEscaped(value));
    }
  }

  return [...values].toSorted((left, right) => right.length - left.length);
};

export const redactText = (text: string, secrets: readonly string[]): string => {
  let redacted = text;

  for (const secret of secrets) {
    redacted = redacted.split(secret).join(redactionMarker);
  }

  return redacted;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

const redactString = (text: string, redaction: Redaction): string => {
  const redacted = redactText(text, redaction.secrets);

  if (redacted !== text) {
    redaction.changed = true;
  }

  return redacted;
};

const redactValue = (value: unknown, redaction: Redaction): unknown => {
  if (typeof value === 'string') {
    return redactString(value, redaction);
  }

  const isWalked = Array.isArray(value) || isPlainObject(value);

  if (!isWalked || redaction.visited.has(value)) {
    return value;
  }

  redaction.visited.add(value);

  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactValue(item, redaction));
  }

  const entries = Object.entries(value).map(([key, item]) => [key, redactValue(item, redaction)]);

  return Object.fromEntries(entries);
};

const redactContentItem = (item: ContentItem, redaction: Redaction): ContentItem =>
  item.type === 'text' ? { ...item, text: redactString(item.text, redaction) } : item;

export const redactToolResult = (
  result: ToolResultFacts,
  secrets: readonly string[],
): ToolResultEventResult | undefined => {
  const redaction: Redaction = { secrets, visited: new WeakSet(), changed: false };
  const content = result.content.map((item) => redactContentItem(item, redaction));
  const details = redactValue(result.details, redaction);
  const structuredContent = redactValue(result.structuredContent, redaction);

  if (!redaction.changed) {
    return undefined;
  }

  const patch: ToolResultEventResult = { content, details };

  if (result.structuredContent !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The walk keeps the JSON shape and only replaces strings.
    patch.structuredContent = structuredContent as StructuredContent;
  }

  return patch;
};
