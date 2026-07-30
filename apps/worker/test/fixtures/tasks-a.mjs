/* Duck-typed TaskHandles for the loader tests: loadTasks() detects shape, not
   class identity (see src/loader.ts), so plain objects are a faithful stand-in
   and keep these fixtures importable as-is. */
export const alpha = { id: 'alpha', __definition: { id: 'alpha', run: async () => 'a' } };

/** A (nested) array export — collect() walks up to depth 3. */
export const grouped = [
  { id: 'beta', __definition: { id: 'beta', run: async () => 'b' } },
  [{ id: 'gamma', __definition: { id: 'gamma', run: async () => 'c' } }],
];

/** Non-tasks that must be ignored rather than tripping the loader. */
export const looksClose = { id: 'delta' };
export const answer = 42;
