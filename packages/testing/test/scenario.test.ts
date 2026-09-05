import { format } from 'node:util';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database', () => ({ resetDb: vi.fn() }));

import { resetDb, type TestDatabase } from '../src/database';
import { runScenario, type Scenario } from '../src/scenario';

const meta = { name: 'probe', db: { name: 'requested_db' } };
const exit = new Error('scenario exited');
let db: TestDatabase;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  vi.stubEnv('BT_KEEP_TEST_DATABASE', undefined);
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { stdout.push(format(...args)); });
  vi.spyOn(console, 'warn').mockImplementation((...args) => { stderr.push(format(...args)); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { stderr.push(format(...args)); });
  // Preserve exit's never-returning contract while checking runScenario's
  // public verdict and output in the normal Vitest process.
  vi.spyOn(process, 'exit').mockImplementation(() => { throw exit; });
  db = {
    name: 'actual_probe_db',
    url: 'postgres://fake_user:fake_password@127.0.0.1:15432/actual_probe_db',
    pool: {} as Pool,
    end: vi.fn(async () => {}),
    drop: vi.fn(async () => {}),
  };
  vi.mocked(resetDb).mockResolvedValue(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(resetDb).mockReset();
});

async function expectVerdict(
  body: (s: Scenario) => Promise<void>,
  passed: number,
  failed: number,
): Promise<void> {
  await expect(runScenario(meta, body)).rejects.toBe(exit);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(failed === 0 ? 0 : 1);
  expect(stdout.join('\n')).toContain(`${passed} passed, ${failed} failed`);
  expect(db.drop).toHaveBeenCalledTimes(1);
  if (failed > 0) expect(stdout.join('\n')).not.toContain('checks passed.');
}

const thrownValues: Array<[string, unknown, string]> = [
  ['null', null, 'null'],
  ['undefined', undefined, 'undefined'],
  ['false', false, 'false'],
  ['zero', 0, '0'],
  ['empty string', '', '""'],
  ['Error', new Error('body boom'), 'body boom'],
  ['string', 'thrown text', 'thrown text'],
  ['symbol', Symbol('thrown symbol'), 'Symbol(thrown symbol)'],
  ['bigint', 0n, '0'],
  ['object without toString', Object.create(null), '<unprintable thrown value>'],
];

describe('runScenario verdict', () => {
  it('exits zero after successful checks and cleanup', async () => {
    const cleanup = vi.fn(async () => {});
    await expectVerdict(async (s) => {
      s.cleanup(cleanup);
      s.ok('body completed');
      await s.check('soft pass', async () => {});
    }, 2, 0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(stdout.join('\n')).toContain('All 2 probe checks passed.');
  });

  it.each(thrownValues)('exits nonzero when the body throws %s', async (_label, value, message) => {
    await expectVerdict(async () => { throw value; }, 0, 1);
    expect(stdout.join('\n')).toContain(`  ✗ ${message}`);
  });

  it.each(thrownValues)('exits nonzero when only cleanup throws %s', async (_label, value, message) => {
    await expectVerdict(async (s) => {
      s.cleanup(() => { throw value; });
      s.ok('body completed');
    }, 1, 1);
    expect(stdout.join('\n')).toContain(`  ✗ teardown step failed: ${message}`);
    expect(stderr.join('\n')).toContain(`teardown step failed: ${message}`);
  });

  it('attempts all cleanup in LIFO order and preserves body and cleanup failures', async () => {
    const order: string[] = [];
    const bodyError = new Error('original body failure');
    vi.mocked(db.drop).mockImplementation(async () => { order.push('pool'); });
    await expectVerdict(async (s) => {
      s.cleanup(() => { order.push('first'); });
      s.cleanup(async () => {
        await Promise.resolve();
        order.push('second');
        throw new Error('async cleanup failure');
      });
      s.cleanup(() => {
        order.push('third');
        throw new Error('sync cleanup failure');
      });
      throw bodyError;
    }, 0, 3);
    expect(order).toEqual(['third', 'second', 'first', 'pool']);
    const summary = stdout.join('\n').split('Failures:')[1];
    expect(summary).toContain('original body failure');
    expect(summary).toContain('async cleanup failure');
    expect(summary).toContain('sync cleanup failure');
    expect(console.error).toHaveBeenCalledWith(bodyError);
  });

  it('includes failure to drop the database in the final verdict', async () => {
    vi.mocked(db.drop).mockRejectedValue(new Error('pool close failure'));
    await expectVerdict(async () => {}, 0, 1);
    expect(stdout.join('\n')).toContain('teardown step failed: pool close failure');
  });

  it('combines soft, body and cleanup failures without double-counting', async () => {
    await expectVerdict(async (s) => {
      s.cleanup(() => { throw new Error('cleanup failure'); });
      await s.check('soft failure', async () => { throw new Error('check failure'); });
      s.ok('continued after soft failure');
      s.fail('assertion failure');
    }, 1, 3);
    expect(stdout.join('\n')).toContain('soft failure: check failure');
    expect(stdout.join('\n')).toContain('assertion failure');
  });

  it('exits nonzero when provisioning rejects with a falsy value', async () => {
    vi.mocked(resetDb).mockRejectedValue(undefined);
    const body = vi.fn(async () => {});
    await expect(runScenario(meta, body)).rejects.toBe(exit);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(body).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('could not provision the database — undefined');
  });
});

describe('runScenario database identity', () => {
  const credentials = [
    {
      label: 'plain credentials',
      authority: 'fake_user:fake_password',
      query: '?password=fake_query_password&sslmode=require#fake_fragment_secret',
      secrets: ['fake_user', 'fake_password', 'fake_query_password', 'fake_fragment_secret'],
    },
    {
      label: 'percent-encoded credentials and query passwords',
      authority: 'fake%40user:fake%3Ap%40ss%2Fword%25',
      query: '?password=query%40p%3Ass%25&passfile=%2Ffake%2Fsecret',
      secrets: [
        'fake%40user', 'fake@user', 'fake%3Ap%40ss%2Fword%25', 'fake:p@ss/word%',
        'query%40p%3Ass%25', 'query@p:ss%', '%2Ffake%2Fsecret', '/fake/secret',
      ],
    },
  ];

  it.each(credentials)('logs only host, port and actual database with $label', async ({ authority, query, secrets }) => {
    const url = `postgres://${authority}@127.0.0.1:15432/actual_probe_db${query}`;
    db.url = url;
    await expectVerdict(async (s) => {
      expect(s.db.url).toBe(url);
    }, 0, 0);
    expect(stdout).toContain('  db 127.0.0.1:15432/actual_probe_db');
    for (const output of [stdout.join('\n'), stderr.join('\n')]) {
      for (const secret of secrets) expect(output).not.toContain(secret);
      expect(output).not.toContain('password=');
      expect(output).not.toContain('sslmode=');
    }
    expect(db.url).toBe(url);
  });

  it('shows the default Postgres port and preserves IPv6 host notation', async () => {
    db.url = 'postgres://fake_user:fake_password@[::1]/actual_probe_db';
    await expectVerdict(async () => {}, 0, 0);
    expect(stdout).toContain('  db [::1]:5432/actual_probe_db');
  });
});

describe('runScenario database retention', () => {
  it.each([false, true])('explicitly retains the database after body failure=%s', async (fail) => {
    await expect(runScenario({ ...meta, keepDatabase: true }, async () => {
      if (fail) throw new Error('body failed');
    })).rejects.toBe(exit);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(fail ? 1 : 0);
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(db.drop).not.toHaveBeenCalled();
    expect(stdout).toContain('  database retained (not dropped): actual_probe_db');
    expect(stdout.join('\n')).not.toContain('fake_password');
  });

  it('allows scripts to opt into retention via BT_KEEP_TEST_DATABASE=1', async () => {
    vi.stubEnv('BT_KEEP_TEST_DATABASE', '1');
    await expect(runScenario(meta, async () => {})).rejects.toBe(exit);
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(db.drop).not.toHaveBeenCalled();
    expect(stdout.join('\n')).toContain('database retained (not dropped)');
  });

  it('lets explicit false override the environment and drop the database', async () => {
    vi.stubEnv('BT_KEEP_TEST_DATABASE', '1');
    await expect(runScenario({ ...meta, keepDatabase: false }, async () => {})).rejects.toBe(exit);
    expect(db.drop).toHaveBeenCalledTimes(1);
    expect(db.end).not.toHaveBeenCalled();
    expect(stdout.join('\n')).not.toContain('retained');
  });

  it('does not mask pool-close failure when retaining the database', async () => {
    vi.mocked(db.end).mockRejectedValueOnce(new Error('retained pool close failed'));
    await expect(runScenario({ ...meta, keepDatabase: true }, async () => {})).rejects.toBe(exit);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(db.drop).not.toHaveBeenCalled();
    expect(stdout.join('\n')).toContain('teardown step failed: retained pool close failed');
  });

  it('keeps both the body failure and database cleanup diagnostics in the verdict', async () => {
    vi.mocked(db.drop).mockRejectedValueOnce(new AggregateError([
      new Error('pool close failed'), new Error('database drop failed'),
    ], 'database cleanup failed'));
    await expectVerdict(async () => { throw new Error('original body failure'); }, 0, 2);
    for (const message of ['original body failure', 'pool close failed', 'database drop failed']) {
      expect(stdout.join('\n')).toContain(message);
    }
  });
});
