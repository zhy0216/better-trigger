/* =============================================================================
   better-trigger — duck-typed schema validation unit tests.

   schema.ts accepts three shapes with zero validation-library dependencies:
   Standard Schema (~standard.validate), zod-style safeParse and zod-style
   parse. These tests pin the duck-typing (isSchema false-negatives), the async
   Standard Schema path, the `{ key }` path segment formatIssues emits, and the
   real-ZodError message extraction.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isSchema, validateSchema, type AnySchema } from '../src/schema';

function standardSchema(
  validate: (value: unknown) => unknown,
): AnySchema<unknown> {
  return { '~standard': { version: 1, vendor: 'test', validate: validate as any } };
}

describe('isSchema — duck typing', () => {
  it('accepts each supported shape', () => {
    expect(isSchema({ '~standard': { version: 1, vendor: 'x', validate: () => ({ value: 1 }) } })).toBe(true);
    expect(isSchema({ safeParse: () => ({ success: true, data: 1 }) })).toBe(true);
    expect(isSchema({ parse: () => 1 })).toBe(true);
  });

  it('false-negatives: near-misses and junk are NOT schemas', () => {
    // Not objects at all.
    expect(isSchema(null)).toBe(false);
    expect(isSchema(undefined)).toBe(false);
    expect(isSchema('z.object({})')).toBe(false);
    expect(isSchema(42)).toBe(false);
    // ~standard present but validate is not a function.
    expect(isSchema({ '~standard': { version: 1, vendor: 'x', validate: 'nope' } })).toBe(false);
    expect(isSchema({ '~standard': {} })).toBe(false);
    // safeParse / parse present but not functions.
    expect(isSchema({ safeParse: 'nope' })).toBe(false);
    expect(isSchema({ parse: 42 })).toBe(false);
    // An empty object implements none of the shapes.
    expect(isSchema({})).toBe(false);
  });
});

describe('validateSchema — async Standard Schema', () => {
  const schema = standardSchema(async (value: unknown) => {
    if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string') {
      return { value: value as { id: string } };
    }
    return { issues: [{ message: 'missing id' }] };
  });

  it('resolves with the parsed value on success (awaiting the async validate)', async () => {
    await expect(validateSchema(schema, { id: 'run_1' })).resolves.toEqual({ id: 'run_1' });
  });

  it('rejects with a SchemaValidationError carrying the issue message', async () => {
    const err = await validateSchema(schema, { nope: 1 }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('SchemaValidationError');
    expect((err as Error).message).toContain('missing id');
  });
});

describe('validateSchema — formatIssues path segments', () => {
  it('formats a `{ key }` segment like a plain path segment', async () => {
    // Standard Schema allows path elements as { key } objects; they must read
    // as `a.b` just like string segments.
    const schema = standardSchema(() => ({
      issues: [{ path: [{ key: 'user' }, 'email'], message: 'invalid format' }],
    }));
    const err = await validateSchema(schema, {}).catch((e: unknown) => e);
    expect((err as Error).message).toContain('user.email: invalid format');
  });

  it('joins several issues with "; " and omits the path when absent', async () => {
    const schema = standardSchema(() => ({
      issues: [
        { path: ['name'], message: 'too short' },
        { message: 'top level' },
      ],
    }));
    const err = await validateSchema(schema, {}).catch((e: unknown) => e);
    expect((err as Error).message).toContain('name: too short; top level');
  });
});

describe('validateSchema — real ZodError extraction', () => {
  const zodSchema = z.object({
    email: z.string().email(),
    count: z.number().int(),
  });

  it('parses valid input through zod-style safeParse', async () => {
    await expect(
      validateSchema(zodSchema, { email: 'a@b.com', count: 1 }),
    ).resolves.toEqual({ email: 'a@b.com', count: 1 });
  });

  it('flattens a real ZodError issues list into path: message pairs', async () => {
    const err = await validateSchema(zodSchema, { email: 'nope', count: 'x' }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('SchemaValidationError');
    const msg = (err as Error).message;
    expect(msg).toContain('email: Invalid email');
    expect(msg).toContain('count: Expected number, received string');
  });
});

describe('validateSchema — parse / safeParse / unsupported shapes', () => {
  it('retags a throwing zod-style parse as a SchemaValidationError', async () => {
    const schema = { parse: () => { throw new Error('bad input'); } };
    const err = await validateSchema(schema, {}).catch((e: unknown) => e);
    expect((err as Error).name).toBe('SchemaValidationError');
    expect((err as Error).message).toContain('bad input');
  });

  it('extracts the message from a safeParse error that is just an Error', async () => {
    const schema = {
      safeParse: () => ({ success: false as const, error: new Error('boom') }),
    };
    const err = await validateSchema(schema, {}).catch((e: unknown) => e);
    expect((err as Error).message).toContain('boom');
  });

  it('rejects a value implementing none of the supported shapes', async () => {
    const err = await validateSchema({} as AnySchema, {}).catch((e: unknown) => e);
    expect((err as Error).name).toBe('SchemaValidationError');
    expect((err as Error).message).toContain('unsupported schema shape');
  });
});
