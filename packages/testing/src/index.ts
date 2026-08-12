/* =============================================================================
   @better-trigger/testing — package surface.

   The shared harness the acceptance scenarios in examples/basic/scripts run on:
   scenario runner + reporting, per-scenario database provisioning, worker-daemon
   control (spawn / health / SIGKILL), polling helpers and the durable-execution
   invariant assertions.

   Private and source-only (see package.json `exports`): it is consumed by
   workspace scenarios through bun, never published, and never imported by
   runtime code. Adding a scenario should be a page, not a copy of a page —
   which is what the P2 fault-injection suite needs.
   ============================================================================= */
export { assert, assertEqual, AssertionFailure, describeError } from './assert';
export {
  baseUrl,
  databaseUrlFor,
  freePort,
  portFromEnv,
  resetDb,
  DEFAULT_DATABASE_URL,
  type ResetDbOptions,
  type TestDatabase,
} from './database';
export {
  killDaemon,
  spawnDaemon,
  startDaemon,
  waitForHealth,
  withDaemon,
  type Daemon,
  type DaemonOptions,
} from './daemon';
export {
  createInvariants,
  readRun,
  readSteps,
  TERMINAL_STATUSES,
  type Invariants,
  type RunRow,
  type StepRow,
} from './invariants';
export { createMarker, type Marker } from './marker';
export { sleep, waitFor, waitForStatus, type RunStatusReader } from './poll';
export { countQueueRows, readLatestCodeVersion, waitForTasks } from './probe';
export { runScenario, type Scenario, type ScenarioMeta } from './scenario';
