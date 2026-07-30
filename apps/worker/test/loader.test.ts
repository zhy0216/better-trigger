/* =============================================================================
   @better-trigger/worker — task loading unit tests.

   loadTasks() is the daemon's front door to user code: it decides what gets
   registered, and its two rejections (an entry that exports nothing runnable, a
   duplicate id) are the difference between a clear startup error and a worker
   that quietly claims nothing. The fixtures are plain objects on purpose —
   detection is duck-typed (see src/loader.ts).
   ============================================================================= */
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTasks } from '../src/loader';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const ids = (tasks: Array<{ id: string }>): string[] => tasks.map((t) => t.id).sort();

describe('loadTasks', () => {
  it('collects handles exported directly and inside (nested) arrays', async () => {
    const loaded = await loadTasks([fixture('tasks-a.mjs')]);
    expect(ids(loaded.tasks)).toEqual(['alpha', 'beta', 'gamma']);
    expect(loaded.entries).toEqual([fixture('tasks-a.mjs')]);
  });

  it('ignores exports that are not task handles', async () => {
    const loaded = await loadTasks([fixture('tasks-a.mjs')]);
    // `looksClose` has an id but no __definition; `answer` is a number.
    expect(loaded.tasks.some((t) => t.id === 'delta')).toBe(false);
    expect(loaded.tasks).toHaveLength(3);
  });

  it('dedupes the same handle reached through two entries', async () => {
    const loaded = await loadTasks([fixture('tasks-a.mjs'), fixture('tasks-b.mjs')]);
    expect(ids(loaded.tasks)).toEqual(['alpha', 'beta', 'epsilon', 'gamma']);
    expect(loaded.entries).toHaveLength(2);
  });

  it('rejects two different definitions sharing an id', async () => {
    await expect(
      loadTasks([fixture('tasks-a.mjs'), fixture('tasks-dup.mjs')]),
    ).rejects.toThrow('duplicate task id "alpha" — two different task() definitions share it');
  });

  it('rejects an entry that exports no tasks', async () => {
    await expect(loadTasks([fixture('no-tasks.mjs')])).rejects.toThrow(
      /exports no tasks — export task\(\) handles/,
    );
  });

  it('wraps an import failure with the entry that caused it', async () => {
    await expect(loadTasks([fixture('does-not-exist.mjs')])).rejects.toThrow(
      /^failed to import tasks entry ".*does-not-exist\.mjs": /,
    );
  });

  it('resolves a relative entry against the cwd', async () => {
    const rel = relative(process.cwd(), fixture('tasks-a.mjs'));
    expect(rel.startsWith('/')).toBe(false);
    const loaded = await loadTasks([rel]);
    expect(ids(loaded.tasks)).toEqual(['alpha', 'beta', 'gamma']);
    // entries echo what the caller passed, not the resolved absolute path.
    expect(loaded.entries).toEqual([rel]);
  });

  it('returns nothing for no entries', async () => {
    await expect(loadTasks([])).resolves.toEqual({ tasks: [], entries: [] });
  });
});
