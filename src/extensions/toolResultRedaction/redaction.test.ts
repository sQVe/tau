import { expect, it } from 'vitest';

import { isSecretName, redactText, redactToolResult, secretValues } from './redaction.js';

const fake = (label: string): string => `fake-${label}-value-1234567890`;

it.each([
  { name: 'OPENROUTER_API_KEY', secret: true },
  { name: 'GH_TOKEN', secret: true },
  { name: 'AWS_SECRET_ACCESS_KEY', secret: true },
  { name: 'AWS_BEARER_TOKEN_BEDROCK', secret: true },
  { name: 'CLIENT_SECRET', secret: true },
  { name: 'DB_PASSWORD', secret: true },
  { name: 'DB_PASSWD', secret: true },
  { name: 'SERVICE_APIKEY', secret: true },
  { name: 'my_api_key', secret: true },
  { name: 'PASSWORD_STORE_DIR', secret: false },
  { name: 'KEYTIMEOUT', secret: false },
  { name: 'GOOGLE_APPLICATION_CREDENTIALS', secret: false },
  { name: 'ANTHROPIC_IDENTITY_TOKEN_FILE', secret: false },
  { name: 'PATH', secret: false },
])('classifies the name $name as secret: $secret', ({ name, secret }) => {
  expect(isSecretName(name)).toBe(secret);
});

it('picks the values of secret names, longest first, without duplicates', () => {
  const longest = `${fake('long')}-extended`;

  const values = secretValues({
    OPENROUTER_API_KEY: fake('one'),
    GH_TOKEN: longest,
    COPY_TOKEN: longest,
    my_api_key: fake('two'),
    PATH: '/usr/bin:/bin:/usr/local/bin',
    SHORT_TOKEN: '1234567',
    EMPTY_TOKEN: undefined,
  });

  expect(values).toEqual([longest, fake('one'), fake('two')]);
});

const secret = fake('text');

it.each([
  { name: 'an assignment', input: `NAME=${secret}`, expected: 'NAME=[redacted]' },
  { name: 'a quoted assignment', input: `NAME='${secret}'`, expected: "NAME='[redacted]'" },
  { name: 'a JSON pair', input: `"NAME":"${secret}"`, expected: '"NAME":"[redacted]"' },
  {
    name: 'two occurrences on one line',
    input: `${secret} and ${secret}`,
    expected: '[redacted] and [redacted]',
  },
  { name: 'text with no secret', input: 'nothing here', expected: 'nothing here' },
])('redacts $name', ({ input, expected }) => {
  expect(redactText(input, [secret])).toBe(expected);
});

it('replaces a value that contains another value whole', () => {
  const longer = `${secret}-extended`;
  const text = `A=${longer} B=${secret}`;

  expect(redactText(text, secretValues({ A_TOKEN: secret, B_TOKEN: longer }))).toBe(
    'A=[redacted] B=[redacted]',
  );
});

const image = { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' } as const;

it('returns nothing when no string holds a secret', () => {
  const patch = redactToolResult(
    {
      content: [{ type: 'text', text: 'clean' }],
      details: { note: 'clean' },
      structuredContent: undefined,
    },
    [secret],
  );

  expect(patch).toBeUndefined();
});

it('redacts text items, keeps images, and redacts nested details and structured content', () => {
  const patch = redactToolResult(
    {
      content: [{ type: 'text', text: `key ${secret}` }, image],
      details: { list: [`a ${secret}`, 3], inner: { value: secret, count: 2 } },
      structuredContent: { rows: [{ line: `x ${secret}` }], flag: true, none: null },
    },
    [secret],
  );

  expect(patch).toEqual({
    content: [{ type: 'text', text: 'key [redacted]' }, image],
    details: { list: ['a [redacted]', 3], inner: { value: '[redacted]', count: 2 } },
    structuredContent: { rows: [{ line: 'x [redacted]' }], flag: true, none: null },
  });
});

it('leaves structured content out of the patch when the result has none', () => {
  const patch = redactToolResult(
    { content: [{ type: 'text', text: secret }], details: undefined, structuredContent: undefined },
    [secret],
  );

  expect(patch).not.toHaveProperty('structuredContent');
});

it('returns a cyclic object unchanged instead of looping', () => {
  const details: Record<string, unknown> = { value: secret };
  details.self = details;

  const patch = redactToolResult({ content: [], details, structuredContent: undefined }, [secret]);

  expect(patch?.details).toMatchObject({ value: '[redacted]' });
});

it('keeps a value of exactly 8 characters and drops one of 7', () => {
  const values = secretValues({ EIGHT_TOKEN: 'fake-8ch', SEVEN_TOKEN: 'fake-7c' });

  expect(values).toEqual(['fake-8ch']);
});

it('redacts strings in a null-prototype object', () => {
  const details = Object.assign(Object.create(null) as Record<string, unknown>, { value: secret });

  const patch = redactToolResult({ content: [], details, structuredContent: undefined }, [secret]);

  expect(patch?.details).toEqual({ value: '[redacted]' });
});

it('leaves the strings of a class instance unchanged', () => {
  class Holder {
    value = secret;
  }

  const patch = redactToolResult(
    {
      content: [{ type: 'text', text: 'clean' }],
      details: new Holder(),
      structuredContent: undefined,
    },
    [secret],
  );

  expect(patch).toBeUndefined();
});

const escapedValue = 'fake-esc\\ape"d-value';
const jsonEscapedValue = 'fake-esc\\\\ape\\"d-value';

it('adds the JSON-escaped form of a value, longest form first across all values', () => {
  const between = 'fake-other-value-1234';

  const values = secretValues({ ESCAPED_TOKEN: escapedValue, OTHER_TOKEN: between });

  expect(values).toEqual([jsonEscapedValue, between, escapedValue]);
});

it('redacts a value that JSON.stringify of the environment escaped', () => {
  const environment = { ESCAPED_TOKEN: escapedValue };
  const output = JSON.stringify(environment);

  expect(redactText(output, secretValues(environment))).toBe('{"ESCAPED_TOKEN":"[redacted]"}');
});

it('redacts the raw form and the JSON-escaped form in one text', () => {
  const text = `raw ${escapedValue} json ${jsonEscapedValue}`;

  expect(redactText(text, secretValues({ ESCAPED_TOKEN: escapedValue }))).toBe(
    'raw [redacted] json [redacted]',
  );
});
