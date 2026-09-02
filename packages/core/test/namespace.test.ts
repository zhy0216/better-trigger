/* =============================================================================
   @better-trigger/core — assertNamespace tests (01-core-sdk).

   Every business row is scoped to a (projectId, env) pair, and the concurrency
   limiter builds an advisory-lock key as `bt:cc:${projectId}:${env}:${key}`
   (packages/kernel/src/queue.ts). So a part must be a non-empty string, at most
   NAMESPACE_PART_MAX_LENGTH chars, and must not contain ':' — a colon would let
   two distinct namespaces collide on one lock key. assertNamespace is the single
   validator every host boundary calls before the kernel sees a namespace.
   ============================================================================= */
import { KernelError } from '../src/kernel-errors';
import { assertNamespace, NAMESPACE_PART_MAX_LENGTH } from '../src/namespace';
import { describe, expect, it } from 'vitest';

describe('assertNamespace', () => {
  it('accepts a well-formed pair', () => {
    expect(() => assertNamespace({ projectId: 'acme', env: 'prod' })).not.toThrow();
    expect(() => assertNamespace({ projectId: 'x', env: 'a-very-long-but-valid-environment-name' })).not.toThrow();
  });

  it('accepts a part at exactly the max length', () => {
    const at = 'a'.repeat(NAMESPACE_PART_MAX_LENGTH);
    expect(() => assertNamespace({ projectId: at, env: at })).not.toThrow();
  });

  it('rejects an empty / non-string part, naming the field', () => {
    for (const bad of ['', undefined, null, 42] as const) {
      let err: unknown;
      try {
        assertNamespace({ projectId: bad as unknown as string, env: 'prod' });
      } catch (e) {
        err = e;
      }
      expect(err, `projectId=${String(bad)}`).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe('bad_request');
      expect((err as KernelError).message).toContain('namespace.projectId');
    }
    expect(() => assertNamespace({ projectId: 'acme', env: '' })).toThrow(/namespace\.env/);
  });

  it('rejects a part longer than the cap', () => {
    const tooLong = 'a'.repeat(NAMESPACE_PART_MAX_LENGTH + 1);
    let err: unknown;
    try {
      assertNamespace({ projectId: tooLong, env: 'prod' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).message).toContain(
      `namespace.projectId must be at most ${NAMESPACE_PART_MAX_LENGTH} characters`,
    );
  });

  it('rejects a ":" in either part (it separates the advisory lock key)', () => {
    expect(() => assertNamespace({ projectId: 'a:b', env: 'prod' })).toThrow(/must not contain ':'/);
    expect(() => assertNamespace({ projectId: 'acme', env: 'p:rod' })).toThrow(/must not contain ':'/);
    // The message points at the offending field.
    expect(() => assertNamespace({ projectId: 'acme', env: 'p:rod' })).toThrow(/namespace\.env/);
  });
});
