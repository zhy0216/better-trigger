/* =============================================================================
   better-trigger — process-wide registry.

   Three pieces of state have to be shared between "code that defines tasks"
   and "code that runs them": the AsyncLocalStorage carrying the active
   executor, the default client, and the resolver RunHandle.result() reads
   from. The worker daemon sets them; user task modules read them.

   They hang off a Symbol.for() slot on globalThis rather than off module
   scope, so a duplicated copy of this package (two node_modules trees, a
   bundled build next to a linked one) still shares ONE registry. Otherwise
   `ctx`-detection would silently fail: triggerAndWait() inside a run would not
   see the executor and would throw "must be called inside a running task".

   Because copies share the slot, adoption is explicit: the slot is stamped
   with a shape version and the creating SDK's version, and a copy that finds
   a foreign object verifies the stamp before it adopts. An object from an
   incompatible future shape (or a corrupted slot) throws instead of being
   silently read with `undefined` fields.
   ============================================================================= */
import type { AsyncLocalStorage } from 'node:async_hooks';
import { getExecutorStorage } from './als';
import type { RunExecutor } from './context';
import type { BetterTrigger, RunResultResolver } from './instance';

/** Keep in sync with packages/sdk/package.json "version". The SDK has no
 *  runtime version export; this constant is the stamp two registry copies use
 *  to detect each other. */
const SDK_VERSION = '0.1.0';

interface Registry {
  /** Shape version. Bumped on an incompatible layout change so an older copy
   *  can never silently adopt a newer object (or vice versa). */
  v: 1;
  /** Version of the SDK that created this registry object. */
  sdkVersion: string;
  /** Holds the executor for the currently running task fn. Lazy (p1-16):
   *  undefined on platforms without node:async_hooks — there is no in-flight
   *  task there, so ctx-detection correctly reads nothing. Populated late via
   *  setExecutorStorage when a daemon resolves it asynchronously (Node ESM
   *  < 22.3). */
  executorStorage: AsyncLocalStorage<RunExecutor> | undefined;
  /** First betterTrigger() instance, or the last one to call setDefault(). */
  defaultInstance: BetterTrigger | null;
  /** Overrides where RunHandle.result() reads from (installed by the daemon). */
  resultResolver: RunResultResolver | null;
}

const KEY = Symbol.for('better-trigger.registry.v1');

type GlobalWithRegistry = typeof globalThis & { [KEY]?: Registry };

const g = globalThis as GlobalWithRegistry;

/** Build the registry object this copy of the SDK contributes. */
function freshRegistry(): Registry {
  return {
    v: 1,
    sdkVersion: SDK_VERSION,
    // Lazy (p1-16): the AsyncLocalStorage CONSTRUCTOR is fetched synchronously
    // here (getBuiltinModule / require). Undefined on edge/browser — there is
    // no in-flight task in those processes. A daemon whose runtime lacks the
    // synchronous path (plain Node ESM < 22.3) resolves it asynchronously at
    // startup and calls setExecutorStorage.
    executorStorage: (() => {
      const Ctor = getExecutorStorage();
      return Ctor ? new Ctor<RunExecutor>() : undefined;
    })(),
    defaultInstance: null,
    resultResolver: null,
  };
}

/**
 * Adopt (or create) the shared registry. An existing object is only accepted
 * when it carries the same shape version; anything else is a hard error so a
 * mis-stamped slot cannot surface later as a cryptic "must be called inside a
 * running task". Two copies at the same shape but different SDK versions still
 * share (their fields are layout-compatible) — they just get a warning, since
 * setDefault()/resolver writes by one copy are visible to the other.
 */
function adopt(existing: unknown): Registry {
  if (existing === undefined) {
    const fresh = freshRegistry();
    g[KEY] = fresh;
    return fresh;
  }
  if (typeof existing !== 'object' || existing === null) {
    throw new Error(
      'better-trigger registry slot is not an object — corrupted globalThis, or another copy of the SDK overwrote it',
    );
  }
  const rec = existing as Partial<Registry>;
  if (rec.v !== 1) {
    throw new Error(
      `better-trigger registry version mismatch (got v${String(rec.v)}) — multiple incompatible copies of the SDK? Reinstall so only one better-trigger is present.`,
    );
  }
  if (
    (rec.executorStorage !== undefined && typeof rec.executorStorage !== 'object') ||
    (rec.defaultInstance !== null && typeof rec.defaultInstance !== 'object') ||
    (rec.resultResolver !== null && typeof rec.resultResolver !== 'object')
  ) {
    throw new Error(
      'better-trigger registry is missing required keys — a corrupted slot, or an incompatible copy',
    );
  }
  if (rec.sdkVersion !== SDK_VERSION) {
    console.warn(
      `better-trigger: two SDK copies share a registry (${rec.sdkVersion} and ${SDK_VERSION}) — duplicate better-trigger in node_modules? Behaviors like setDefault()/ctx detection may not sync.`,
    );
  }
  return rec as Registry;
}

export const registry: Registry = adopt(g[KEY]);

/** Populate the shared executor storage late (p1-16): used by the daemon after
 *  an asynchronous node:async_hooks load on runtimes without the sync path. */
export function setExecutorStorage(storage: AsyncLocalStorage<RunExecutor> | undefined): void {
  registry.executorStorage = storage;
}
