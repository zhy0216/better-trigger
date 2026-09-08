import type { Pool, PoolClient } from 'pg';

type ProbeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'query_failed' | 'timeout' };

/**
 * One checkout/query at a time for a health or metrics route. The HTTP answer
 * has a deadline, but the flight belongs to the underlying operation: after
 * expiry, callers share the failed answer until checkout/query settles.
 *
 * statement_timeout bounds SQL on a responsive server. It cannot make an HTTP
 * timeout proof of SQL cancellation (for example when the network is lost).
 * A query still pending at the deadline must explicitly destroy its client;
 * a checkout arriving afterwards is returned without issuing any query.
 */
export function createDbProbe<T>(
  pool: Pool,
  query: (client: PoolClient) => Promise<T>,
  timeoutMs: number,
): () => Promise<ProbeResult<T>> {
  let inflight: Promise<ProbeResult<T>> | null = null;

  return () => {
    if (inflight) return inflight;
    let resolve!: (result: ProbeResult<T>) => void;
    const response = new Promise<ProbeResult<T>>((done) => { resolve = done; });
    inflight = response;
    let finished = false;
    let owned: PoolClient | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const failed = { ok: false, error: 'query_failed' } as const;

    const finish = (result: ProbeResult<T>): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const release = (destroy: boolean): void => {
      const client = owned;
      if (!client) return;
      // Transfer ownership before release, including any synchronous events.
      // Late query settlement must not release this checkout a second time.
      owned = null;
      try {
        if (destroy) client.release(true);
        else client.release();
      } catch {
        // A failed release is a failed probe; retrying could double-release.
        finish(failed);
      } finally {
        // pg-pool installs its idle error listener during release. Keep ours
        // until then so a borrowed-client error never has an unhandled gap.
        client.removeListener('error', onError);
      }
    };
    const onError = (): void => {
      finish(failed);
      release(true);
    };

    timer = setTimeout(() => {
      finish({ ok: false, error: 'timeout' });
      release(true);
    }, timeoutMs);

    const work = async (): Promise<void> => {
      try {
        const client = await pool.connect();
        owned = client;
        if (finished) {
          release(false);
          return;
        }
        client.on('error', onError);
        const value = await query(client);
        release(false);
        finish({ ok: true, value });
      } catch {
        release(true);
        finish(failed);
      }
    };
    const settled = (): void => {
      // Also fold an unexpected cleanup failure into the public failure shape.
      finish(failed);
      inflight = null;
    };
    // Observe late checkout/query rejections, and unlock only when work ends.
    // Clearing on response settlement would queue another operation per 2s.
    void work().then(settled, settled);
    return response;
  };
}
