/* A second entry that re-exports one of tasks-a's handles — the common case
   loadTasks() must dedupe instead of rejecting as a duplicate id. */
export { alpha } from './tasks-a.mjs';

export const epsilon = { id: 'epsilon', __definition: { id: 'epsilon', run: async () => 'e' } };
