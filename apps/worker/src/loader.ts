/* =============================================================================
   @better-trigger/worker — task loading.

   The daemon executes YOUR task code, so it has to import your modules. Point
   it at one or more entry files (`--tasks ./src/tasks.ts`) and every TaskHandle
   they export — directly, or inside an exported array — gets registered.

   Detection is duck-typed rather than instanceof: a user's module may resolve
   `better-trigger` through its own node_modules, so class identity is not a
   reliable signal. (Sharing the executor storage across such copies is handled
   by the SDK's process-wide registry, not here.)
   ============================================================================= */
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskHandle } from 'better-trigger';

type AnyTask = TaskHandle<any, any>;

/** Duck-typed TaskHandle check — see the header for why not instanceof. */
function isTaskHandle(value: unknown): value is AnyTask {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { id?: unknown; __definition?: { run?: unknown } };
  return (
    typeof v.id === 'string' &&
    typeof v.__definition === 'object' &&
    v.__definition !== null &&
    typeof v.__definition.run === 'function'
  );
}

/** Collect TaskHandles out of an export value: the handle itself, or an
 *  array (possibly nested) of them. Anything else is ignored. */
function collect(value: unknown, out: AnyTask[], depth = 0): void {
  if (isTaskHandle(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value) && depth < 3) {
    for (const item of value) collect(item, out, depth + 1);
  }
}

export interface LoadedTasks {
  tasks: AnyTask[];
  /** Entry specifiers that were imported, in order. */
  entries: string[];
}

/**
 * Import every entry and gather the tasks it exports. Duplicate ids are an
 * error unless they are literally the same handle (the common case: two entry
 * files re-exporting one module).
 */
export async function loadTasks(entries: string[]): Promise<LoadedTasks> {
  const byId = new Map<string, AnyTask>();

  for (const entry of entries) {
    const abs = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to import tasks entry "${entry}": ${detail}`);
    }

    const found: AnyTask[] = [];
    for (const value of Object.values(mod)) collect(value, found);
    if (found.length === 0) {
      throw new Error(
        `tasks entry "${entry}" exports no tasks — export task() handles, or an array of them, from it`,
      );
    }

    for (const t of found) {
      const existing = byId.get(t.id);
      if (existing && existing !== t) {
        throw new Error(
          `duplicate task id "${t.id}" — two different task() definitions share it`,
        );
      }
      byId.set(t.id, t);
    }
  }

  return { tasks: [...byId.values()], entries };
}
