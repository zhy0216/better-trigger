/* =============================================================================
   @better-trigger/worker — the single source of truth for every
   `BETTER_TRIGGER_*` environment knob the worker and kernel read.

   main.ts renders its `--help` Env block from this list, .env.example and
   apps/worker/README.md mirror it by hand, and the anti-drift test
   (test/env-registry.test.ts) greps the source for `process.env.` / `env.`
   / string-literal reads and asserts the two sets are equal in both
   directions — a new env read without a registry entry fails, and a dead
   registry entry fails.

   Kernel knobs (packages/kernel/src/runs.ts reads them via `envLimit` /
   `process.env`) are registered HERE, by the worker, so --help / README /
   .env.example and the test all look at one table.

   The categories drive the --help grouping and the .env.example sections:
   core / network-posture / limits / rate-limit / tuning.

   Knobs documented elsewhere and deliberately NOT in this registry:
   - `VITE_BT_API_KEY` — baked into the apps/web bundle, never read by the
     daemon (documented in apps/web/README.md);
   - `BETTER_TRIGGER_URL` — the SDK's target, read by packages/sdk, not the
     worker/kernel (documented in .env.example and packages/sdk/README.md);
   - the `BT_*` acceptance-harness vars.
   ============================================================================= */

/** One documented configuration knob. */
export interface EnvKnob {
  /** The env var name, e.g. `BETTER_TRIGGER_MAX_STEPS`. */
  name: string;
  /** One of: core / network-posture / limits / rate-limit / tuning. */
  category: string;
  /** Default as shown in --help / .env.example; "(unset)" when none. */
  default: string;
  /** One-line purpose. The renderer appends "(default: X)". */
  help: string;
}

export const ENV_KNOBS: EnvKnob[] = [
  // ---- core -------------------------------------------------------------
  {
    name: 'BETTER_TRIGGER_API_KEY',
    category: 'core',
    default: '(unset)',
    help: 'When set, the API requires `Authorization: Bearer <key>`; unset = local mode, no auth. May carry a @YYYY-MM-DD expiry suffix past which it answers 401 key_expired.',
  },
  {
    name: 'BETTER_TRIGGER_API_KEYS',
    category: 'core',
    default: '(unset)',
    help: 'Additional bearer keys, comma-separated (each may carry the same @YYYY-MM-DD expiry suffix). Any configured key authenticates — the rotation mechanism.',
  },
  {
    name: 'BETTER_TRIGGER_CONCURRENCY',
    category: 'core',
    default: '5',
    help: 'Concurrent execution slots.',
  },
  {
    name: 'BETTER_TRIGGER_PIN_CODE_VERSION',
    category: 'core',
    default: '(unset)',
    help: '1/true = same as --pin-code-version: claim only runs stamped with the code version this process serves for that task.',
  },
  {
    name: 'BETTER_TRIGGER_VERSION',
    category: 'core',
    default: 'build identity',
    help: 'Code version reported on registration, overriding the default build identity (0.1.0+<git sha>) — name deploys as your pipeline does.',
  },

  // ---- network-posture --------------------------------------------------
  {
    name: 'BETTER_TRIGGER_HOST',
    category: 'network-posture',
    default: '127.0.0.1',
    help: 'Bind address (same as --host). Loopback only by default; use 0.0.0.0 to accept connections from the network.',
  },
  {
    name: 'BETTER_TRIGGER_ALLOW_UNAUTHENTICATED',
    category: 'network-posture',
    default: '(unset)',
    help: '1/true = same as --allow-unauthenticated: permit a non-loopback --host without an API key.',
  },
  {
    name: 'BETTER_TRIGGER_CORS_ORIGIN',
    category: 'network-posture',
    default: '(unset)',
    help: 'Extra browser origins allowed to call the API, comma-separated (same as --cors-origin). localhost/127.0.0.1/[::1] are always allowed; `*` allows any origin.',
  },
  {
    name: 'BETTER_TRIGGER_NAMESPACES',
    category: 'network-posture',
    default: 'default/prod',
    help: 'Namespaces this worker serves, comma-separated <projectId>/<env> pairs (same as --namespace).',
  },

  // ---- limits -----------------------------------------------------------
  {
    name: 'BETTER_TRIGGER_BODY_LIMIT',
    category: 'limits',
    default: '1048576 (1 MiB)',
    help: 'Max request body in bytes; over it the API answers 413 payload_too_large.',
  },
  {
    name: 'BETTER_TRIGGER_MAX_BATCH',
    category: 'limits',
    default: '500',
    help: 'Max items in one batchTrigger; over it 400 bad_request — split the fan-out into batches.',
  },
  {
    name: 'BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES',
    category: 'limits',
    default: '1048576 (1 MiB)',
    help: 'Max TOTAL serialized payload across one batchTrigger; over it 400 bad_request — split the fan-out.',
  },
  {
    name: 'BETTER_TRIGGER_MAX_PAYLOAD_BYTES',
    category: 'limits',
    default: '262144 (256 KiB)',
    help: 'Max serialized payload per run; over it 413 payload_too_large — keep large objects elsewhere and pass a reference.',
  },
  {
    name: 'BETTER_TRIGGER_MAX_STEPS',
    category: 'limits',
    default: '10000',
    help: 'Cap on a run\'s replayed step ledger; a run past it fails with a non-retryable AbortError — split it with continueAsNew. 0 = unlimited.',
  },
  {
    name: 'BETTER_TRIGGER_MAX_RECOVERIES',
    category: 'limits',
    default: '10',
    help: 'Reaper recovery budget stamped on new runs; a run recovered more than this is failed rather than requeued. 0 = never recover a lost run.',
  },
  {
    name: 'BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES',
    category: 'limits',
    default: '262144 (256 KiB)',
    help: 'Max serialized output/error per step row; over it the step records failed with a SerializationError diagnostic and the run fails.',
  },
  {
    name: 'BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES',
    category: 'limits',
    default: '262144 (256 KiB)',
    help: 'Max serialized run output; over it the run fails 413 payload_too_large.',
  },
  {
    name: 'BETTER_TRIGGER_ERROR_MAX_BYTES',
    category: 'limits',
    default: '65536 (64 KiB)',
    help: 'Max serialized error record; a larger one is stored as a SerializationError stub so the failure still lands.',
  },
  {
    name: 'BETTER_TRIGGER_LOG_DATA_MAX_BYTES',
    category: 'limits',
    default: '16384 (16 KiB)',
    help: 'Max serialized `data` on one log line; an over-limit line keeps its message and stores { omitted: true, reason } in data.',
  },
  {
    name: 'BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES',
    category: 'limits',
    default: '65536 (64 KiB)',
    help: 'Max serialized message on one log line; a longer one is stored as a SerializationError stub.',
  },
  {
    name: 'BETTER_TRIGGER_LOG_BATCH_MAX_BYTES',
    category: 'limits',
    default: '262144 (256 KiB)',
    help: 'Max serialized payload of one log INSERT; a flush over it is split into more statements.',
  },

  // ---- rate-limit -------------------------------------------------------
  {
    name: 'BETTER_TRIGGER_RATE_LIMIT_RPS',
    category: 'rate-limit',
    default: '50',
    help: 'Per-key per-endpoint token-bucket rate on trigger / batch-trigger / retry / cancel (tokens/s). 0 disables the per-key bucket.',
  },
  {
    name: 'BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS',
    category: 'rate-limit',
    default: '200',
    help: 'Per-endpoint token-bucket rate over all keys (tokens/s). 0 disables the global bucket. In-memory per process — an exact fleet-wide cap belongs at the reverse proxy.',
  },
  {
    name: 'BETTER_TRIGGER_RATE_LIMIT_READ_RPS',
    category: 'rate-limit',
    default: '200',
    help: 'Per-key token-bucket rate across the read surface (/api/v1 reads: record, result, /runs, /tasks, /schedules, /workers, /metrics). 0 disables the per-key read bucket.',
  },
  {
    name: 'BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS',
    category: 'rate-limit',
    default: '1000',
    help: 'Token-bucket rate over all keys across the whole read surface (tokens/s). 0 disables the global read bucket. In-memory per process, like the write buckets.',
  },
  {
    name: 'BETTER_TRIGGER_RATE_LIMIT_BURST',
    category: 'rate-limit',
    default: 'larger write rate above',
    help: 'Token-bucket burst capacity (max burst) for both write and read buckets. 0 is honoured; negative or unparseable values fall back to the default.',
  },

  // ---- tuning -----------------------------------------------------------
  {
    name: 'BETTER_TRIGGER_POOL_MAX',
    category: 'tuning',
    default: 'derived (concurrency + 8)',
    help: 'Override for the business-pool connection max, otherwise derived as --concurrency + 8 headroom for the orchestrator loops, heartbeat, waiter sweep and HTTP slack.',
  },
  {
    name: 'BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS',
    category: 'tuning',
    default: '10000',
    help: 'Pool checkout / connect timeout in ms; a saturated pool answers a checkout with an error after this instead of queueing forever. 0 = wait forever (pg\'s default).',
  },
  {
    name: 'BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS',
    category: 'tuning',
    default: '30000',
    help: 'Server-side statement timeout in ms, sent as statement_timeout in the connection startup packet so PostgreSQL itself cancels a query that runs longer. 0 = off.',
  },
  {
    name: 'BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION',
    category: 'tuning',
    default: '(unset)',
    help: 'Default off: a stray unhandledRejection is logged and counted on better_trigger_unhandled_rejections_total while the daemon keeps serving. Set to 1 to make it fatal (exit 1) like an uncaughtException.',
  },
  {
    name: 'BETTER_TRIGGER_STATS_TTL_MS',
    category: 'tuning',
    default: '10000',
    help: 'Cache TTL for /tasks stats, per namespace; 0 disables the cache.',
  },
];

/** Category → heading used by --help and .env.example. */
export const ENV_CATEGORY_TITLES: Record<string, string> = {
  core: 'Core',
  'network-posture': 'Network posture',
  limits: 'Limits',
  'rate-limit': 'Rate limiting',
  tuning: 'Tuning',
};

const VALID_CATEGORIES = new Set(Object.keys(ENV_CATEGORY_TITLES));

for (const knob of ENV_KNOBS) {
  if (!VALID_CATEGORIES.has(knob.category)) {
    throw new Error(`env-registry: unknown category "${knob.category}" for ${knob.name}`);
  }
}
const uniqueNames = new Set(ENV_KNOBS.map((k) => k.name));
if (uniqueNames.size !== ENV_KNOBS.length) {
  const dupes = ENV_KNOBS.filter((k) => uniqueNames.delete(k.name)).map((k) => k.name);
  throw new Error(`env-registry: duplicate knob name(s): ${dupes.join(', ')}`);
}
