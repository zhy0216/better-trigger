/* Barrel: the kernel run lifecycle, split by section (p2-09 C1). Every named
   export of the original runs.ts is re-exported here unchanged; the lock-order
   documentation lives in runs-internal.ts. */
export {
  withTx,
  type RunRow,
  getRunRow,
  lockRunRow,
  tryLockRunRow,
  RETRY_OPERATION_UNIQUE_CONSTRAINT,
} from './runs-internal';
export {
  type CreateRunArgs,
  createRun,
  createRunIn,
  type TriggerArgs,
  trigger,
  batchTrigger,
} from './runs-create';
export {
  type ReportStepArgs,
  type StepWriteArgs,
  type StepWriteOutcome,
  reportStep,
  upsertStep,
  type SuspendRunArgs,
  suspendRun,
  type WaitForChildRunArgs,
  waitForChildRun,
  type BatchTriggerChildArgs,
  batchTriggerChild,
} from './runs-steps';
export {
  wakeParentIfWaiting,
  terminalFail,
  type CompleteRunArgs,
  completeRun,
  type FailRunArgs,
  type FailResult,
  failRun,
  cancelRun,
  retryRun,
} from './runs-terminal';
export { appendLogs } from './runs-logs';
export {
  getRunRecord,
  type RunDetailOptions,
  getRunDetail,
  waitForResult,
} from './runs-read';
