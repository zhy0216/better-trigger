/* =============================================================================
   @better-trigger/worker — env-registry anti-drift test (todos/p2-26).

   Every `BETTER_TRIGGER_*` knob the worker and the kernel read must be
   registered in src/env-registry.ts (the single source --help / .env.example /
   apps/worker/README.md are rendered from or mirror), and every registry entry
   must actually be read — no dead entries.

   The read set is grepped out of the source (apps/worker/src +
   packages/kernel/src) with the three shapes a knob is actually read as:
     - `process.env.BETTER_TRIGGER_X`              (main.ts, app.ts, …)
     - `env.BETTER_TRIGGER_X` on an env parameter  (middleware.ts, rate-limit.ts, pool-config.ts)
     - `envLimit('BETTER_TRIGGER_X', …)` — string literals (kernel/runs.ts)
   Comments and template-literal error messages do not count as reads, so a
   knob that is only *mentioned* is reported dead.

   Deliberately outside this registry: `VITE_BT_API_KEY` (baked into the apps/web
   bundle), `BETTER_TRIGGER_URL` (read by the SDK, not the daemon) and the
   `BT_*` acceptance-harness vars — all documented where they live.
   ============================================================================= */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_KNOBS } from '../src/env-registry';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRS = [
  join(HERE, '..', 'src'),
  join(HERE, '..', '..', '..', 'packages', 'kernel', 'src'),
];

/** Recursively collect every .ts file under `dir`. */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const sourceText = SOURCE_DIRS.flatMap(walkTs).map((f) => readFileSync(f, 'utf8')).join('\n');

/** The read shapes above. A knob must match at least one to count as read.
 *  Whitespace-tolerant: the version read spans a newline (`process?.env\n ?.X`). */
const READS = [
  /(?:\.env|(?:^|[^A-Za-z0-9_])env)\s*\??\.(BETTER_TRIGGER_[A-Z0-9_]+)/g,
  /envLimit\(\s*['"](BETTER_TRIGGER_[A-Z0-9_]+)/g,
];

const readNames = new Set<string>();
for (const re of READS) {
  for (const m of sourceText.matchAll(re)) readNames.add(m[1]!);
}

const registryNames = new Set(ENV_KNOBS.map((k) => k.name));

describe('env-registry vs source reads', () => {
  it('registers every BETTER_TRIGGER_* knob the worker and kernel read (no drift)', () => {
    const unregistered = [...readNames]
      .filter((name) => !registryNames.has(name))
      .sort();
    expect(unregistered, 'env read without a registry entry — add it to src/env-registry.ts').toEqual([]);
  });

  it('every registry entry is actually read in the source (no dead entries)', () => {
    const dead = ENV_KNOBS.filter((k) => !readNames.has(k.name)).map((k) => k.name);
    expect(dead, 'registry entry with no source read — remove it or its read went missing').toEqual([]);
  });

  it('registry entries are unique and follow the canonical category order', () => {
    const names = ENV_KNOBS.map((k) => k.name);
    expect(new Set(names).size).toBe(names.length);
    // The order the registry is written in is the --help / .env.example
    // display order, pinned so a reorder cannot drift the docs silently.
    const order = ['core', 'network-posture', 'limits', 'rate-limit', 'tuning'];
    expect(ENV_KNOBS.map((k) => k.category)).toEqual(order.flatMap((c) =>
      ENV_KNOBS.filter((k) => k.category === c).map(() => c),
    ));
  });

  it('VITE_BT_API_KEY is NOT in the registry (documented separately)', () => {
    expect(registryNames.has('VITE_BT_API_KEY')).toBe(false);
  });
});
