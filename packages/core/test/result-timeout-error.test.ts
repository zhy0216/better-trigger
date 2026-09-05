import { describe, expect, it } from 'vitest';
import { ResultTimeoutError } from '../src/index';

describe('ResultTimeoutError', () => {
  it.each(['running', undefined] as const)('preserves the public error shape with status %s', (status) => {
    const error = new ResultTimeoutError('run_1', 250, status);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ResultTimeoutError);
    expect(error.name).toBe('ResultTimeoutError');
    expect(error.status).toBe(status);
    expect(error.message).toBe('run run_1 did not reach a terminal state within 250ms'
      + (status === undefined ? '' : ' (status running)'));
  });
});
