import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../errors.js';
import { get, label } from '../hc/hc.js';
import type { HcRuntime } from '../hc/hc.js';
import type { Wake } from '../wake/wake.js';
import { readEnvelope } from './envelope.js';
import {
  decideCandidate,
  decideEnvelopeSession,
  inboxMessageType,
  inboxReceiptVersion,
} from './receiptDecision.js';
import type { ReceiptStore } from './receipts.js';

type LabelRead =
  | { kind: 'read'; labels: Record<string, string> }
  | { kind: 'failed'; message: string };

export interface StartupGate {
  whenReady: () => Promise<void>;
  isReady: () => boolean;
}

export interface InboxScanContext {
  sessionManager: Pick<ExtensionContext['sessionManager'], 'getEntries'>;
  ui: ExtensionContext['ui'];
  isIdle: () => boolean;
  signal: AbortSignal | undefined;
}

// The session generation that owns this receiver. `isCurrent` is false once the generation stops
// or its subscription closes. `confirmOwnership` reads the lease again right before a wake.
export interface ReceiverFence {
  observe: (observed: string | undefined) => void;
  isCurrent: () => boolean;
  confirmOwnership: () => Promise<boolean>;
}

export interface ReceiverDependencies {
  hc: HcRuntime;
  terminal: string;
  sessionId: string;
  gate: StartupGate;
  wake: Wake;
  notify: (context: InboxScanContext, message: string, key: string) => void;
  receipts: ReceiptStore;
  fence: ReceiverFence;
}

export interface Receiver {
  scan: (context: InboxScanContext) => Promise<void>;
}

const inboxLabelPrefix = 'tau.inbox.';
const leaseLabel = 'tau.inbox';

const deliver = (
  dependencies: ReceiverDependencies,
  context: InboxScanContext,
  messageId: string,
  text: string,
): void => {
  dependencies.receipts.markQueued(messageId);

  dependencies.wake(context, {
    customType: inboxMessageType,
    content: text,
    display: true,
    details: {
      version: inboxReceiptVersion,
      messageId,
      sessionId: dependencies.sessionId,
      family: 'handover',
    },
  });
};

const removeLabel = async (
  dependencies: ReceiverDependencies,
  messageId: string,
): Promise<void> => {
  try {
    await label(dependencies.hc, dependencies.terminal, {
      [`${inboxLabelPrefix}${messageId}`]: '',
    });
  } catch {
    // A failed removal keeps the receipt, so the next scan retries it without another wake.
  }
};

const handleLabel = async (
  dependencies: ReceiverDependencies,
  context: InboxScanContext,
  messageId: string,
  path: string,
): Promise<void> => {
  const step = decideCandidate({
    hasOwnReceipt: dependencies.receipts.hasReceipt(messageId),
    queued: dependencies.receipts.isQueued(messageId),
  });

  if (step === 'cleanup') {
    await removeLabel(dependencies, messageId);

    return;
  }

  if (step === 'pending') {
    return;
  }

  const read = await readEnvelope(path, { messageId, terminal: dependencies.terminal });

  if (!dependencies.fence.isCurrent()) {
    return;
  }

  if (read.kind === 'refused') {
    dependencies.notify(
      context,
      `Inbox message ${messageId} was refused: ${read.reason}`,
      `refused:${path}:${read.reason}`,
    );

    return;
  }

  const sessionStep = decideEnvelopeSession(read.envelope.targetSessionId, dependencies.sessionId);

  if (sessionStep === 'defer') {
    return;
  }

  await dependencies.gate.whenReady();

  const owned = await dependencies.fence.confirmOwnership();

  if (!owned || !dependencies.fence.isCurrent()) {
    return;
  }

  deliver(dependencies, context, messageId, read.envelope.text);
};

const readLabels = async (dependencies: ReceiverDependencies): Promise<LabelRead> => {
  try {
    const current = await get(dependencies.hc, dependencies.terminal);

    return { kind: 'read', labels: current.labels ?? {} };
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) };
  }
};

export const createReceiver = (dependencies: ReceiverDependencies): Receiver => {
  const scan = async (context: InboxScanContext): Promise<void> => {
    dependencies.receipts.restore(context.sessionManager.getEntries());

    const read = await readLabels(dependencies);

    if (!dependencies.fence.isCurrent()) {
      return;
    }

    if (read.kind === 'failed') {
      dependencies.notify(context, `Inbox scan failed: ${read.message}`, 'inbox-scan');

      return;
    }

    const { labels } = read;

    dependencies.fence.observe(labels[leaseLabel]);

    for (const [key, path] of Object.entries(labels)) {
      if (!key.startsWith(inboxLabelPrefix)) {
        continue;
      }

      const messageId = key.slice(inboxLabelPrefix.length);

      if (messageId === '') {
        continue;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- envelope reads stay sequential.
      await handleLabel(dependencies, context, messageId, path);

      if (!dependencies.fence.isCurrent()) {
        return;
      }
    }
  };

  return { scan };
};
