// Strictly-bounded best-effort log appends (p2-40).

import type { Pool } from 'pg';
import {
  assertNamespace,
  safeSerializeJson,
  type LogEntry,
  type LogLevel,
  type Namespace,
} from '@better-trigger/core';
import type { KernelLogger } from './kernel';
import {
  logBatchMaxBytes,
  logDataMaxBytes,
  logMessageMaxBytes,
  withTx,
} from './runs-internal';

/* ---------------------------------------------------------------------------
 * Logs (no fencing; strict terminal boundary via the runs row lock, p2-40)
 * ------------------------------------------------------------------------- */

/** Rows per INSERT. 5 bind params each (+3 shared: run_id + the namespace
 *  pair) → 5003 params, well under pg's 65535. */
const LOG_INSERT_CHUNK = 1000;
/** Fixed per-row allowance for the VALUES syntax, casts and separators around
 *  one row's parameters, added to the parameter bytes when packing chunks. */
const LOG_ROW_SQL_OVERHEAD_BYTES = 64;

/** One log line prepared for binding: everything JSON-encoded up front. */
interface PreparedLogRow {
  stepSeq: number | null;
  level: string;
  message: string;
  dataJson: string | null;
  ts: string;
  /** Estimated bytes the row occupies in one INSERT statement's parameters. */
  bytes: number;
}

/* The closed enum of the logs_level_check CHECK (0011), plus the requirement
   that ts is a string pg can cast to timestamptz. Worker log messages arrive
   as JSON: without a per-line check, one bad level/ts makes the chunk INSERT
   fail at the database (23514 / 22007 — a 500-class error that also rolls
   back its good neighbours), against the "dropping a flush never throws"
   contract. Logs are the best-effort data plane, so the bad line is dropped
   with a warn and the rest of the batch is written. */
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function isWritableLogLine(e: LogEntry): boolean {
  return (
    LOG_LEVELS.includes(e.level) &&
    typeof e.ts === 'string' &&
    !Number.isNaN(Date.parse(e.ts))
  );
}

/** ONE shared encoder/decoder pair: the old per-call `new TextEncoder()` made
 *  a 64 KiB-over-limit message pay ~64k encoder constructions (one per code
 *  point) plus a full-string encode just to measure — this is the log hot
 *  path (05-T4). */
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

const utf8Bytes = (s: string): number => UTF8_ENCODER.encode(s).length;

/** Truncate a string to at most maxBytes UTF-8 bytes, appending '…' (3 bytes)
 *  when it was cut. Encodes ONCE, backs the cut off to a code-point boundary
 *  (a continuation byte is 0b10xxxxxx, so walking back lands on the lead byte
 *  of the character the budget split — which is then dropped whole), and
 *  decodes the kept prefix once: O(bytes) instead of one encode per code
 *  point. */
export function truncateUtf8(s: string, maxBytes: number): string {
  const bytes = UTF8_ENCODER.encode(s);
  if (bytes.length <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - 3);
  let end = Math.min(budget, bytes.length);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${UTF8_DECODER.decode(bytes.subarray(0, end))}…`;
}

function preparedRowBytes(r: PreparedLogRow): number {
  return (
    utf8Bytes(String(r.stepSeq)) +
    utf8Bytes(r.level) +
    utf8Bytes(r.message) +
    utf8Bytes(r.dataJson ?? 'null') +
    utf8Bytes(r.ts) +
    LOG_ROW_SQL_OVERHEAD_BYTES
  );
}

/**
 * Serialize one log line's data and cap its message; an over-limit or
 * unserializable data value is replaced with a small diagnostic record so the
 * LINE survives (logs must not be lost; data may be).
 */
function prepareLogRow(e: LogEntry): PreparedLogRow {
  let dataJson: string | null = null;
  if (e.data !== undefined) {
    const res = safeSerializeJson(e.data, logDataMaxBytes(), 'data');
    if (res.ok) dataJson = res.json;
    else dataJson = JSON.stringify({ omitted: true, reason: res.message });
  }
  const row: PreparedLogRow = {
    stepSeq: e.stepSeq ?? null,
    level: e.level,
    message: truncateUtf8(e.message, logMessageMaxBytes()),
    dataJson,
    ts: e.ts,
    bytes: 0,
  };
  return { ...row, bytes: preparedRowBytes(row) };
}

/**
 * A single line that already exceeds the whole batch cap: drop its data
 * first, then trim the message, so the line still fits inside one statement.
 */
function shrinkRowForBatch(row: PreparedLogRow, maxBytes: number): PreparedLogRow {
  let next: PreparedLogRow = row;
  if (next.dataJson !== null) {
    next = {
      ...next,
      dataJson: JSON.stringify({ omitted: true, reason: 'data omitted: line exceeds the log batch cap' }),
    };
  }
  if (preparedRowBytes(next) > maxBytes) {
    // Budget for the message = what the row leaves after everything else.
    const budget = Math.max(0, maxBytes - (preparedRowBytes(next) - utf8Bytes(next.message)));
    next = { ...next, message: truncateUtf8(next.message, budget) };
  }
  return { ...next, bytes: preparedRowBytes(next) };
}

/**
 * Append log lines to a run. Best effort in one direction only — no fencing (a
 * superseded executor's last flush is still worth keeping) and no error when
 * the write lands nowhere — but STRICT about the terminal boundary: no log
 * line ever commits after the run's own finished_at.
 *
 * Linearization (p2-40): each chunk runs in its own short transaction that
 * first takes the run row `FOR UPDATE` and reads finished_at under the lock.
 * A terminal tx (complete/fail/cancel) holds the same row lock while it sets
 * finished_at, so every chunk is serialized against the terminal write:
 *   - the chunk that gets the lock first inserts BEFORE finished_at exists —
 *     its lines are part of the run's history;
 *   - a chunk that gets the lock after the terminal commit sees
 *     finished_at IS NOT NULL (or the run gone) and drops itself — 0 rows,
 *     no error, one `[runs:logs]` warn distinguishing "run does not exist"
 *     from "already terminal (late flush / terminal race)";
 *   - a line that cannot fit the batch cap even after shrinkRowForBatch is
 *     dropped before any chunk is built, counted under the same warn as a
 *     third verdict ("over-cap line"), never silently.
 * There is no "statement snapshot passed the liveness test, then the FK check
 * waited for the terminal tx and inserted anyway" window left: the INSERT no
 * longer carries a `WHERE EXISTS (...)` guard, and the FK's key-share check is
 * satisfied by the very lock the decision was made under. A run that goes
 * terminal mid-flush stops absorbing the remaining chunks exactly at the
 * chunk boundary.
 *
 * Lock cost: the run row is held only for the duration of one chunk's INSERT
 * (the chunk cap bounds it to ≤ LOG_INSERT_CHUNK rows / one statement), NOT
 * the whole flush — each chunk is its own tx, so a multi-chunk flush releases
 * the lock between chunks. The executor flushes once a second per in-flight
 * run with a 50-line threshold (usually one chunk), so the steady-state
 * overhead is one extra `SELECT ... FOR UPDATE` round trip per flush; a
 * terminal tx can be delayed only by the INSERT it is actually racing, on the
 * order of a single statement's write time.
 */
export async function appendLogs(
  pool: Pool,
  runId: string,
  namespace: Namespace,
  entries: LogEntry[],
  logger: KernelLogger = console,
): Promise<void> {
  if (entries.length === 0) return;
  assertNamespace(namespace);

  // Prepare every line up front (per-line data cap + message cap applied
  // here), shrink any line that would alone exceed the batch cap, then pack
  // chunks by BOTH bounds: pg's 65535 bind-param ceiling (LOG_INSERT_CHUNK
  // rows per statement) and the serialized byte cap for one statement
  // (BETTER_TRIGGER_LOG_BATCH_MAX_BYTES) — a flush over the byte cap is split
  // into more statements, never a single oversized one. Each chunk re-checks
  // the run, so a run that goes terminal mid-flush simply stops absorbing the
  // remaining chunks.
  const maxBatchBytes = logBatchMaxBytes();
  let oversizeLines = 0;
  let invalidLines = 0;
  const rows: PreparedLogRow[] = [];
  for (const e of entries) {
    // Bad level / unparseable ts: dropped here, before any chunk is built, so
    // one garbage line can neither poison its own INSERT nor a neighbour's
    // (isWritableLogLine). The rest of the flush lands normally.
    if (!isWritableLogLine(e)) {
      invalidLines += 1;
      continue;
    }
    let row = prepareLogRow(e);
    if (preparedRowBytes(row) > maxBatchBytes) {
      row = shrinkRowForBatch(row, maxBatchBytes);
    }
    // Under an operator-tuned cap smaller than the smallest possible line the
    // line cannot be written at all; drop it rather than emit an oversized
    // INSERT (a 1-byte cap cannot be honored any other way). The drop is
    // counted and said out loud like the missing/terminal drops below — a
    // silent loss here would read as "logs are fine" under a mis-set cap.
    if (preparedRowBytes(row) <= maxBatchBytes) rows.push(row);
    else oversizeLines += 1;
  }
  const chunks: PreparedLogRow[][] = [];
  let current: PreparedLogRow[] = [];
  let currentBytes = 0;
  for (const row of rows) {
    if (
      current.length > 0 &&
      (current.length >= LOG_INSERT_CHUNK || currentBytes + row.bytes > maxBatchBytes)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += row.bytes;
  }
  if (current.length > 0) chunks.push(current);

  let missingLines = 0;
  let terminalLines = 0;

  for (const chunk of chunks) {
    const values: string[] = [];
    // $1 is the run id, $2/$3 the namespace (shared by the lock SELECT and the
    // INSERT's SELECT list); row params start at $4.
    const params: unknown[] = [runId, namespace.projectId, namespace.env];
    let i = 4;
    for (const r of chunk) {
      // Casts are required, not decoration: inside a VALUES sub-select pg has no
      // target column to infer an untyped parameter from, so it would settle on
      // text and then refuse to assign text to step_seq / data / ts.
      values.push(
        `($${i++}::int, $${i++}::text, $${i++}::text, $${i++}::jsonb, $${i++}::timestamptz)`,
      );
      params.push(r.stepSeq, r.level, r.message, r.dataJson, r.ts);
    }
    // Each chunk is its own short transaction: lock the run row, decide under
    // the lock, insert, commit. The row lock is released at COMMIT, so the
    // hold time is one INSERT at most, never the whole flush.
    await withTx(pool, async (client) => {
      const locked = await client.query<{ finished_at: Date | null }>(
        `SELECT finished_at FROM runs WHERE id = $1 AND project_id = $2 AND env = $3 FOR UPDATE`,
        [runId, namespace.projectId, namespace.env],
      );
      if (!locked.rows[0]) {
        // Run gone (or not in this namespace — same verdict: this flush has
        // no home). finished_at can never go back to NULL and a missing run
        // never reappears, so every remaining chunk drops too; the single
        // warn at the end reports the whole flush.
        missingLines += chunk.length;
        return;
      }
      if (locked.rows[0].finished_at !== null) {
        // Terminal: this chunk raced a complete/fail/cancel and lost (or the
        // flush is simply late). Strict boundary — the lines are dropped, and
        // the run's history ends at finished_at.
        terminalLines += chunk.length;
        return;
      }
      // No EXISTS guard anymore: the lock above IS the liveness decision, so
      // there is no snapshot-then-wait-on-FK window a terminal commit could
      // slip through. The FK's key-share check on runs is satisfied by the
      // FOR UPDATE we already hold.
      await client.query(
        `INSERT INTO logs (project_id, env, run_id, step_seq, level, message, data, ts)
         SELECT $2::text, $3::text, $1::text, v.step_seq, v.level, v.message, v.data, v.ts
           FROM (VALUES ${values.join(',')}) AS v(step_seq, level, message, data, ts)`,
        params,
      );
    });
  }

  // One warn per flush, first verdict wins. Invalid and over-cap lines were
  // dropped during preparation, before any chunk ran, so they name the verdict
  // when they exist; otherwise the chunk loop's missing/terminal verdicts
  // apply. In practice a flush hits exactly one of the four.
  const dropped =
    invalidLines > 0
      ? ({ kind: 'invalid', lines: invalidLines } as const)
      : oversizeLines > 0
        ? ({ kind: 'oversize', lines: oversizeLines } as const)
        : missingLines > 0
          ? ({ kind: 'missing', lines: missingLines } as const)
          : terminalLines > 0
            ? ({ kind: 'terminal', lines: terminalLines } as const)
            : null;

  if (dropped !== null) {
    // Observable, never fatal: logs are the best-effort data plane, but the
    // boundary is strict, so the drop is recorded once per flush with the
    // verdict that caused it (bad line vs run absent vs terminal race vs an
    // over-cap line), not retried.
    const who = `run ${runId} (${namespace.projectId}/${namespace.env})`;
    if (dropped.kind === 'invalid') {
      logger.warn(
        `[runs:logs] dropped ${dropped.lines} log line(s): ${who} carried a bad level or ` +
          `ts (level must be one of ${LOG_LEVELS.join('/')}, ts must parse as a timestamp) ` +
          `— the rest of the flush was written`,
      );
    } else if (dropped.kind === 'missing') {
      logger.warn(`[runs:logs] dropped ${dropped.lines} log line(s): ${who} does not exist`);
    } else if (dropped.kind === 'terminal') {
      logger.warn(
        `[runs:logs] dropped ${dropped.lines} log line(s): ${who} already terminal ` +
          `— lines past the terminal boundary (late flush or terminal race)`,
      );
    } else {
      logger.warn(
        `[runs:logs] dropped ${dropped.lines} log line(s): each exceeds the log batch cap ` +
          `even after truncation — check BETTER_TRIGGER_LOG_BATCH_MAX_BYTES ` +
          `(an operator-tuned cap smaller than one line cannot be honored)`,
      );
    }
  }
}
