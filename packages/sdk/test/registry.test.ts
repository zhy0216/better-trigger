/* =============================================================================
   better-trigger — process-wide registry adoption across SDK copies.

   The registry hangs off a Symbol.for() slot on globalThis (not module scope)
   so two copies of this package in one process — two node_modules trees, a
   bundled build next to a linked one — still share ONE registry. Because the
   copies share the slot, adoption is explicit: a copy that finds a foreign
   object verifies the shape stamp before adopting it; an object from an
   incompatible shape (or a corrupted slot) throws instead of being silently
   read with `undefined` fields.

   The slot is the ONLY cross-copy channel, so "a second copy" is simulated by
   writing the slot directly and re-importing the module (vi.resetModules() +
   dynamic import) — that is exactly what a second copy sees at import time.
   ============================================================================= */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The exact key registry.ts stamps (Symbol.for, so copies share it). */
const REGISTRY_KEY = Symbol.for('better-trigger.registry.v1');

/** The version a same-version copy would leave behind (registry.ts SDK_VERSION). */
const SDK_VERSION = '0.1.0';

function setSlot(value: unknown): void {
  (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY] = value;
}

function deleteSlot(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
}

/** A foreign registry object in the current shape version. executorStorage is
 *  an object (never undefined) so the shape check passes. */
function validForeign(sdkVersion: string = SDK_VERSION): object {
  return {
    v: 1,
    sdkVersion,
    executorStorage: {},
    defaultInstance: null,
    resultResolver: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  deleteSlot();
  vi.resetModules();
});

describe('registry adoption across SDK copies', () => {
  it('a fresh import creates the registry with v: 1 and the SDK version', async () => {
    deleteSlot();
    vi.resetModules();
    const { registry } = await import('../src/registry');

    expect(registry.v).toBe(1);
    expect(registry.sdkVersion).toBe(SDK_VERSION);
    expect(registry.defaultInstance).toBeNull();
    expect(registry.resultResolver).toBeNull();
  });

  it('re-adopts a same-version foreign registry silently (no console.warn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setSlot(validForeign(SDK_VERSION));
    vi.resetModules();
    const { registry } = await import('../src/registry');

    // Same shape + same version → adopted as-is, fields read back intact.
    expect(registry.v).toBe(1);
    expect(registry.sdkVersion).toBe(SDK_VERSION);
    expect(registry.defaultInstance).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns (but still adopts) when two copies at different versions share the slot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setSlot(validForeign('0.0.9'));
    vi.resetModules();
    const { registry } = await import('../src/registry');

    // Layout-compatible, so the copies still share — the mismatch is flagged.
    expect(registry.sdkVersion).toBe('0.0.9');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/two SDK copies/);
    expect(warn.mock.calls[0]?.[0]).toContain('0.0.9');
    expect(warn.mock.calls[0]?.[0]).toContain('0.1.0');
  });

  it('throws on a valid-version slot missing required keys', async () => {
    setSlot({ v: 1, sdkVersion: SDK_VERSION });
    vi.resetModules();
    await expect(import('../src/registry')).rejects.toThrow(/registry/);
  });

  it('throws on an incompatible shape version', async () => {
    setSlot({ v: 2, sdkVersion: SDK_VERSION, executorStorage: {}, defaultInstance: null, resultResolver: null });
    vi.resetModules();
    await expect(import('../src/registry')).rejects.toThrow(/version mismatch/);
  });
});
