export interface EnvelopeIdentity {
  filenameMessageId: string;
  envelopeMessageId: string;
  targetTerminal: string;
}

export interface ExpectedEnvelope {
  messageId: string;
  terminal: string;
}

export type EnvelopeIdentityVerdict = { kind: 'accept' } | { kind: 'refuse'; reason: string };

export const judgeEnvelopeIdentity = (
  identity: EnvelopeIdentity,
  expected: ExpectedEnvelope,
): EnvelopeIdentityVerdict => {
  if (identity.filenameMessageId !== expected.messageId) {
    return {
      kind: 'refuse',
      reason: `The envelope filename names message "${identity.filenameMessageId}", not "${expected.messageId}".`,
    };
  }

  if (identity.envelopeMessageId !== expected.messageId) {
    return {
      kind: 'refuse',
      reason: `The envelope names message "${identity.envelopeMessageId}", not "${expected.messageId}".`,
    };
  }

  if (identity.targetTerminal !== expected.terminal) {
    return {
      kind: 'refuse',
      reason: `The envelope targets terminal "${identity.targetTerminal}", not "${expected.terminal}".`,
    };
  }

  return { kind: 'accept' };
};
