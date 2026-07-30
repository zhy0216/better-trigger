/* =============================================================================
   @better-trigger/testing — marker file.

   The exactly-once probe: a task appends a line per side effect, the scenario
   counts the lines. It lives in a file (not in the database) precisely because
   it must survive the SIGKILL that the durable ledger is being tested against.

   The task module reads $BT_MARKER_FILE — pass `marker.env` to the daemon.
   ============================================================================= */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Marker {
  /** Absolute path; also exposed via `env` for the daemon child. */
  file: string;
  /** `{ BT_MARKER_FILE: file }`, ready to spread into DaemonOptions.env. */
  env: Record<string, string>;
  /** How many lines exactly equal `name`. */
  count(name: string): number;
  /** All non-empty lines, in order. */
  lines(): string[];
}

/** Create an empty marker file in a fresh temp directory. */
export function createMarker(prefix: string): Marker {
  const file = join(mkdtempSync(join(tmpdir(), `${prefix}-`)), 'marker.txt');
  writeFileSync(file, '');
  const read = (): string[] => readFileSync(file, 'utf8').split('\n');
  return {
    file,
    env: { BT_MARKER_FILE: file },
    count: (name) => read().filter((l) => l === name).length,
    lines: () => read().filter((l) => l.length > 0),
  };
}
