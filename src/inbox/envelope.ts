import { realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';

import { errorMessage } from '../errors.js';
import { parseVersionedRecord, readContainedText } from '../record.js';
import { isRecord } from '../schema.js';
import { checkTauDirectory, findTauRoot } from '../tauDirectory.js';
import { judgeEnvelopeIdentity } from './envelopeDecision.js';
import { isSessionId } from './leaseDecision.js';

export interface ExpectedEnvelope {
  messageId: string;
  terminal: string;
}

export type EnvelopeRead =
  | { kind: 'valid'; envelope: InboxEnvelope }
  | { kind: 'refused'; reason: string };

export const envelopeByteLimit = 102_400;

const envelopeSchema = Type.Object(
  {
    version: Type.Literal(1),
    messageId: Type.String({ minLength: 1, maxLength: 200 }),
    targetTerminal: Type.String({ minLength: 1, maxLength: 500 }),
    targetSessionId: Type.String({ minLength: 1 }),
    family: Type.Literal('handover'),
    text: Type.String(),
  },
  { additionalProperties: false },
);

export type InboxEnvelope = Static<typeof envelopeSchema>;

export const serializeEnvelope = (envelope: InboxEnvelope): string =>
  `${JSON.stringify(envelope, null, 2)}\n`;

const envelopeOptions = {
  label: 'envelope',
  version: 1,
  schema: envelopeSchema,
  check: (value: unknown) => {
    if (!isRecord(value)) {
      return undefined;
    }

    const sessionId = value['targetSessionId'];

    if (typeof sessionId !== 'string' || isSessionId(sessionId)) {
      return undefined;
    }

    return '/targetSessionId must be 1 to 500 characters';
  },
};

const envelopePathMarker = `${sep}.tau${sep}inbox${sep}`;

const parseEnvelopePath = (path: string): { root: string; messageId: string } | undefined => {
  const absolute = resolve(path);
  const markerIndex = absolute.lastIndexOf(envelopePathMarker);

  if (markerIndex <= 0) {
    return undefined;
  }

  const root = absolute.slice(0, markerIndex);
  const fileName = absolute.slice(markerIndex + envelopePathMarker.length);

  if (fileName === '' || fileName.includes(sep) || !fileName.endsWith('.json')) {
    return undefined;
  }

  const messageId = fileName.slice(0, -'.json'.length);

  return messageId === '' ? undefined : { root, messageId };
};

export const readEnvelope = async (
  path: string,
  expected: ExpectedEnvelope,
): Promise<EnvelopeRead> => {
  const parsed = parseEnvelopePath(path);

  if (parsed === undefined) {
    return { kind: 'refused', reason: `Not an inbox envelope path: ${path}` };
  }

  let root: string;

  try {
    root = await findTauRoot(parsed.root, 'inbox');

    if (root !== (await realpath(parsed.root))) {
      return {
        kind: 'refused',
        reason: `The envelope root is not a Git checkout: ${parsed.root}`,
      };
    }

    await checkTauDirectory(root, 'inbox');
  } catch (error) {
    return { kind: 'refused', reason: errorMessage(error) };
  }

  let text: string;

  try {
    text = await readContainedText({
      directory: join(root, '.tau', 'inbox'),
      path,
      byteLimit: envelopeByteLimit,
      label: 'envelope',
    });
  } catch (error) {
    return { kind: 'refused', reason: errorMessage(error) };
  }

  let envelope: InboxEnvelope;

  try {
    envelope = parseVersionedRecord(path, text, envelopeOptions);
  } catch (error) {
    return { kind: 'refused', reason: errorMessage(error) };
  }

  const verdict = judgeEnvelopeIdentity(
    {
      filenameMessageId: parsed.messageId,
      envelopeMessageId: envelope.messageId,
      targetTerminal: envelope.targetTerminal,
    },
    expected,
  );

  if (verdict.kind === 'refuse') {
    return { kind: 'refused', reason: verdict.reason };
  }

  return { kind: 'valid', envelope };
};
