import { WorkerControllerLifecycle } from './WorkerControllerLifecycle.js';

export { agentPromptArguments, workerArguments } from './controllerInspect.js';
export type { HerdrClient } from './controllerInspect.js';
export { taskStatus } from './controllerRecord.js';

export class WorkerController extends WorkerControllerLifecycle {}
