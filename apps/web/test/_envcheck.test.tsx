import { expect, it } from 'vitest';
it('defaults to jsdom without a docblock (p2-34)', () => {
  expect(typeof document).toBe('object');
});
