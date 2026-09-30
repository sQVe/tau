import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isWorkerProcess } from '../../workerProcess/index.js';
import { createCompactionBoundary } from './boundary.js';
import type { WorkerLedgerReader } from './boundary.js';

// Only the manager compacts here. Workers keep Pi's own compaction, so Pi's settings stay unchanged.
export default function compactionExtension(
  pi: ExtensionAPI,
  readWorkerLedger: WorkerLedgerReader,
): void {
  if (isWorkerProcess()) {
    return;
  }

  const boundary = createCompactionBoundary(readWorkerLedger);

  pi.on('turn_end', boundary.compact);
  pi.on('agent_before_settle', boundary.compact);

  pi.on('session_start', () => {
    boundary.startSession();
  });

  pi.on('session_shutdown', () => {
    boundary.shutdown();
  });
}
