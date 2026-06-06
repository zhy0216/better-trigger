/* =============================================================================
   better-trigger — duck-typed schema validation.
   Supports three shapes without depending on any validation library:
     1. Standard Schema  — `schema['~standard'].validate(input)`
     2. zod-style safeParse — `schema.safeParse(input) -> { success, data, error }`
     3. zod-style parse     — `schema.parse(input) -> data | throws`
   Payload types are inferred from these shapes (see InferSchema below).
   ============================================================================= */

/* ---- Standard Schema (https://standardschema.dev) minimal surface -------- */

interface StandardSchemaResultSuccess<T> {
  value: T;
  issues?: undefined;
}
interface StandardSchemaIssue {
  message: string;
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
}
interface StandardSchemaResultFailure {
  issues: ReadonlyArray<StandardSchemaIssue>;
}
type StandardSchemaResult<T> = StandardSchemaResultSuccess<T> | StandardSchemaResultFailure;

interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

/* ---- zod-style duck types ------------------------------------------------ */

interface SafeParseSchema<Output> {
  safeParse: (
    input: unknown,
  ) =>
    | { success: true; data: Output }
    | { success: false; error: unknown };
}

interface ParseSchema<Output> {
  parse: (input: unknown) => Output;
}

/** Any supported schema shape. */
export type AnySchema<Output = unknown> =
  | StandardSchemaV1<unknown, Output>
  | SafeParseSchema<Output>
  | ParseSchema<Output>;

/** Infer the validated output type from a supported schema. */
export type InferSchema<S> =
  S extends StandardSchemaV1<unknown, infer O>
    ? O
    : S extends SafeParseSchema<infer O>
      ? O
      : S extends ParseSchema<infer O>
        ? O
        : never;

function hasStandard(s: unknown): s is StandardSchemaV1 {
  return (
    typeof s === 'object' &&
    s !== null &&
    '~standard' in s &&
    typeof (s as StandardSchemaV1)['~standard']?.validate === 'function'
  );
}
function hasSafeParse(s: unknown): s is SafeParseSchema<unknown> {
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof (s as SafeParseSchema<unknown>).safeParse === 'function'
  );
}
function hasParse(s: unknown): s is ParseSchema<unknown> {
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof (s as ParseSchema<unknown>).parse === 'function'
  );
}

/** True when a value looks like one of the supported schema shapes. */
export function isSchema(s: unknown): s is AnySchema {
  return hasStandard(s) || hasSafeParse(s) || hasParse(s);
}

function formatIssues(issues: ReadonlyArray<StandardSchemaIssue>): string {
  return issues
    .map((i) => {
      const path = (i.path ?? [])
        .map((p) => (typeof p === 'object' && p !== null ? String(p.key) : String(p)))
        .join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}

/**
 * Validate `input` against a supported schema, returning the parsed value.
 * Throws a plain Error (with name 'SchemaValidationError') on failure; the
 * executor treats that as an AbortError (no retry).
 */
export async function validateSchema<Output>(
  schema: AnySchema<Output>,
  input: unknown,
): Promise<Output> {
  if (hasStandard(schema)) {
    const result = await schema['~standard'].validate(input);
    if (result.issues) {
      throw schemaError(formatIssues(result.issues));
    }
    return result.value as Output;
  }
  if (hasSafeParse(schema)) {
    const result = schema.safeParse(input);
    if (!result.success) {
      throw schemaError(extractZodMessage(result.error));
    }
    return result.data as Output;
  }
  if (hasParse(schema)) {
    // zod-style parse throws on failure; let it propagate, retag as schema error.
    try {
      return schema.parse(input) as Output;
    } catch (err) {
      throw schemaError((err as Error)?.message ?? 'schema validation failed');
    }
  }
  throw schemaError('unsupported schema shape');
}

function schemaError(message: string): Error {
  const err = new Error(`schema validation failed: ${message}`);
  err.name = 'SchemaValidationError';
  return err;
}

function extractZodMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
    if (Array.isArray(issues)) {
      return issues
        .map((i) => {
          const path = Array.isArray(i.path) ? i.path.join('.') : '';
          return path ? `${path}: ${i.message}` : i.message ?? '';
        })
        .join('; ');
    }
    if (typeof (error as { message?: string }).message === 'string') {
      return (error as { message: string }).message;
    }
  }
  return String(error);
}
