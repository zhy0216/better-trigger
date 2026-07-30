/* A *different* handle claiming an id tasks-a already uses — must be rejected. */
export const alpha = {
  id: 'alpha',
  __definition: { id: 'alpha', run: async () => 'a-from-elsewhere' },
};
