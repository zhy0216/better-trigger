/* =============================================================================
   @better-trigger/example-basic — run detail snapshot + log pagination e2e
   (PF3, todos/02-performance.md).

   The unit tests pin the SQL shape of getRunDetail; they cannot prove the
   HTTP behavior on a real database. This scenario runs a task that logs 1199
   info lines, one error-level line (the 1200th), and fails, then asserts
   through a real daemon's GET /runs/:id that:

     - the default page is the NEWEST 200 lines, ascending (chronological),
       and its LAST line is the run's error line — the very output the old
       "first 1000 lines" read used to cut off;
     - `logsNextCursor` + `?logsBefore=` (via the SDK client) walk back
       through every older page to the first line (6 pages × 200, all 1200
       lines exactly once);
     - the response carries the PF3 truncation fields;
     - a run that is STILL RUNNING serves a complete, internally consistent
       detail — the four parts (run/steps/waits/logs) come from one
       REPEATABLE READ snapshot, so a live read never mixes states.

   Env:
     DATABASE_URL   base connection derived from it; default
                    postgres://localhost:5432/better_trigger
     BT_RUN_DETAIL_DB   override the database name prefix
     BT_RUN_DETAIL_PORT override the daemon's port (default 4909)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  portFromEnv,
  runScenario,
  startDaemon,
  waitFor,
  type Scenario,
} from '@better-trigger/testing';
import {
  betterTrigger,
  type RunDetailResult,
} from 'better-trigger';

const PORT = portFromEnv('BT_RUN_DETAIL_PORT', 4909);
const TASKS_MODULE = fileURLToPath(new URL('./run-detail-tasks.ts', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(s: Scenario): Promise<void> {
  const daemon = await startDaemon({
    databaseUrl: s.db.url,
    port: PORT,
    tasks: TASKS_MODULE,
    concurrency: 5,
    migrate: true,
  });
  s.cleanup(() => daemon.stop());
  s.log(`daemon ${daemon.url}`);

  const trigger = betterTrigger({ url: daemon.url! });
  const handle = await trigger.trigger('log-storm', {});
  await handle.result(); // long-polls to the terminal (failed) state

  const detail: RunDetailResult = await trigger.getRunDetail(handle.id);

  await s.check('default detail = newest 200 logs, ascending, last line is the error', async () => {
    s.assert(detail.run.status === 'failed', `log-storm status = ${detail.run.status}, expected failed`);
    s.assert(detail.logs.length === 200, `default logs page = ${detail.logs.length}, expected 200`);
    s.assertEqual(detail.logs[0]!.message, 'line 1000', 'first line of the default page');
    // The acceptance: the run's LAST log line (1200th) is an error-level line
    // and it IS on the default page — the old "first 1000 lines" read never
    // showed it.
    const last = detail.logs[detail.logs.length - 1]!;
    s.assertEqual(last.level, 'error', 'last line must be error-level');
    s.assert(
      last.message.includes('final error'),
      `last line must be the run's final error, got "${last.message}"`,
    );
    for (let i = 1; i < detail.logs.length; i++) {
      s.assert(
        detail.logs[i]!.id > detail.logs[i - 1]!.id,
        'logs must come back ascending (chronological)',
      );
    }
    s.assert(detail.logsNextCursor !== null, 'cursor must be set while older logs exist');
    s.assert(detail.stepsTruncated === false, 'small run must not report steps truncated');
    s.assert(detail.waitsTruncated === false, 'small run must not report waits truncated');
  });

  await s.check('logsBefore pages back through all 1200 lines (6 × 200)', async () => {
    const seen = new Set(detail.logs.map((l) => l.message));
    let cursor = detail.logsNextCursor;
    let pages = 1;
    while (cursor !== null) {
      // Paging goes through the SDK client's opts.logsBefore, not a raw fetch.
      const page = await trigger.getRunDetail(handle.id, undefined, { logsBefore: cursor });
      s.assert(page.logs.length === 200, `page ${pages} = ${page.logs.length} lines, expected 200`);
      for (let i = 0; i < page.logs.length; i++) {
        if (i > 0) {
          s.assert(page.logs[i]!.id > page.logs[i - 1]!.id, 'each page must be ascending');
        }
        seen.add(page.logs[i]!.message);
      }
      cursor = page.logsNextCursor;
      pages += 1;
      s.assert(pages <= 20, 'paging must terminate (cursor loop guard)');
    }

    s.assert(pages === 6, `expected 6 pages (1200 lines / 200), walked ${pages}`);
    s.assert(seen.size === 1200, `expected 1200 distinct lines across pages, got ${seen.size}`);
    s.assert(seen.has('line 0'), 'first line must be reachable through the cursor');
    s.assert(seen.has('final error'), 'the error line must be reachable through the cursor');
  });

  await s.check('a live run serves a complete, internally consistent detail', async () => {
    const live = await trigger.trigger('long-run', {});
    // Wait until the run is actually executing AND its first log flush has
    // landed — that is the state where a non-snapshot read could disagree.
    let startedAt: string | null = null;
    await waitFor(
      `long-run to be running with logs`,
      10_000,
      async () => {
        const d = await trigger.getRunDetail(live.id);
        if (d.run.status === 'running' && d.logs.length > 0) {
          startedAt = d.run.startedAt;
          return true;
        }
        return false;
      },
      { intervalMs: 100 },
    ).catch(() => {
      throw new Error('long-run never reached running-with-logs within 10s');
    });
    s.assert(startedAt !== null, 'running run must carry startedAt');

    // Every read while the run is live must come back complete and
    // self-consistent. REPEATABLE READ (kernel.getRunDetail) guarantees the
    // run row, steps, waits and logs all reflect the same instant — here we
    // assert the visible consequences: no partial/empty parts, within-response
    // ordering, and logs that never predate the run's start.
    for (let i = 0; i < 3; i++) {
      const d = await trigger.getRunDetail(live.id);
      s.assert(d.run.status === 'running', `live read ${i} saw status ${d.run.status}`);
      s.assert(Array.isArray(d.steps) && Array.isArray(d.waits), `live read ${i} must be complete`);
      s.assert(d.logs.length > 0, `live read ${i} must see the flushed logs`);
      for (let j = 1; j < d.logs.length; j++) {
        s.assert(d.logs[j]!.id > d.logs[j - 1]!.id, `live read ${i}: logs must be ascending`);
      }
      const startMs = Date.parse(startedAt!);
      for (const l of d.logs) {
        s.assert(
          Date.parse(l.ts) >= startMs - 1000,
          `live read ${i}: a log must not predate the run start`,
        );
      }
      await sleep(80);
    }

    await live.result(); // let the run settle before teardown
  });
}

await runScenario(
  {
    name: 'run-detail',
    what: 'run detail serves one snapshot with newest-first logs + backward pagination (PF3)',
    // Not migrated here on purpose: the daemon's own `--migrate` is under test
    // (same choice as the e2e harness).
    db: { name: 'better_trigger_run_detail', envVar: 'BT_RUN_DETAIL_DB', migrate: false },
  },
  main,
);
