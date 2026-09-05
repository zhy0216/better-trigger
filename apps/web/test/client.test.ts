/* =============================================================================
   Better Trigger — dashboard HTTP client error-mapping tests (O5).

   The worker answers non-2xx with one of several envelope shapes (contract
   §4): { error: { code, message } }, a flat { message }, a flat { error:
   "text" }, or a non-JSON body. The client must fold all of them into an
   ApiError with the right status/message/code — including the production
   internal_error envelope whose requestId must survive for bug reports.
   ============================================================================= */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { api, ApiError, setApiKey } from '../src/api/client';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, statusText: 'Mapped' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  setApiKey(null);
  vi.unstubAllGlobals();
});

describe('ApiError parsing', () => {
  it('maps the canonical { error: { code, message } } envelope', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'conflict', message: 'run is not terminal' } }, 409));
    await expect(api.cancelRun('r1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'conflict',
      message: 'run is not terminal',
    });
  });

  it('maps a flat { message } body', async () => {
    fetchMock.mockResolvedValue(json({ message: 'plain message' }, 400));
    await expect(api.cancelRun('r1')).rejects.toMatchObject({
      status: 400,
      code: null,
      message: 'plain message',
    });
  });

  it('maps a flat { error: "text" } body', async () => {
    fetchMock.mockResolvedValue(json({ error: 'string error' }, 400));
    await expect(api.cancelRun('r1')).rejects.toMatchObject({
      status: 400,
      message: 'string error',
    });
  });

  it('reads a top-level code even without an error object', async () => {
    fetchMock.mockResolvedValue(json({ code: 'bad_request' }, 400));
    await expect(api.cancelRun('r1')).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
  });

  it('keeps the production internal_error envelope including the requestId', async () => {
    fetchMock.mockResolvedValue(
      json({ error: { code: 'internal_error', message: 'internal error', requestId: 'req_abc123def456' } }, 500),
    );
    const err = await api.cancelRun('r1').catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 500,
      code: 'internal_error',
      message: 'internal error',
      requestId: 'req_abc123def456',
    });
  });

  it('leaves requestId absent when the envelope carries none', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'conflict', message: 'nope' } }, 409));
    const err = await api.cancelRun('r1').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, requestId: undefined });
  });

  it('falls back to the status text for a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>nope</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(api.cancelRun('r1')).rejects.toMatchObject({
      status: 502,
      code: null,
      message: 'Bad Gateway',
    });
  });

  it('returns the parsed JSON on success', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }, 200));
    await expect(api.cancelRun('r1')).resolves.toEqual({ ok: true });
  });

  it('carries the machine code on errors the dashboard must distinguish', async () => {
    // 401 unauthorized vs 503 unavailable must stay distinguishable in code,
    // not just status — classifyConnectionError keys off status 401.
    fetchMock.mockResolvedValue(json({ error: { code: 'unauthorized', message: 'invalid key' } }, 401));
    await expect(api.health()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('is an Error with the ApiError name (survives instanceof checks)', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'not_found' } }, 404));
    try {
      await api.cancelRun('r1');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe('request timeout', () => {
  const hungFetch = () =>
    vi.fn((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        // Reject like a real fetch does when its signal aborts — but ONLY on
        // abort, so the request would otherwise hang forever.
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })),
        );
      }),
    );

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a stalled request at the deadline as a timeout (not an AbortError)', async () => {
    fetchMock.mockImplementation(hungFetch());
    const settled = api.health().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(9_000);
    // Nothing settles before the deadline — the fetch is still pending.
    let done = false;
    void settled.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = (await settled) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe('AbortError');
    expect(err.message).toMatch(/timed out/i);
  });

  it('a caller cancellation still surfaces an AbortError (usePoll swallows it)', async () => {
    fetchMock.mockImplementation(hungFetch());
    const ctrl = new AbortController();
    const settled = api.health(ctrl.signal).catch((e: Error) => e);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(((await settled) as Error).name).toBe('AbortError');
  });
});

/** Headers arrive independently of a partial JSON body, as with real fetch.
 * Aborting the fetch signal errors the stream even after headers arrived. */
function streamingResponse(signal: AbortSignal, status: number) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const onAbort = () => controller.error(signal.reason);
  const response = new Response(new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      ctrl.enqueue(new TextEncoder().encode('{"ok":'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
  }), { status, statusText: 'Service Unavailable' });
  return {
    response,
    finish() {
      signal.removeEventListener('abort', onAbort);
      controller.enqueue(new TextEncoder().encode('true}'));
      controller.close();
    },
  };
}

describe('complete request lifetime', () => {
  let caller: AbortController;
  let added: MockInstance<AbortSignal['addEventListener']>;
  let removed: MockInstance<AbortSignal['removeEventListener']>;

  beforeEach(() => {
    vi.useFakeTimers();
    caller = new AbortController();
    added = vi.spyOn(caller.signal, 'addEventListener');
    removed = vi.spyOn(caller.signal, 'removeEventListener');
  });

  afterEach(async () => {
    // Also release a stalled fixture when a regression assertion fails.
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function expectCleanedUp() {
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledExactlyOnceWith('abort', added.mock.calls[0]![1]);
    expect(vi.getTimerCount()).toBe(0);
  }

  it.each([200, 503])('times out a stalled %i body at the original deadline', async (status) => {
    fetchMock.mockImplementation((_url: unknown, init: RequestInit) =>
      streamingResponse(init.signal!, status).response,
    );
    const outcome = vi.fn();
    void api.health(caller.signal).then(outcome, outcome);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).not.toHaveBeenCalled();
    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    // Inspect settlement without awaiting a promise that the old code leaves
    // pending forever. The body must actually error, not just own a timer.
    expect(outcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: 'Error', message: 'Request timed out after 10000ms',
    }));
    expect(signal.aborted).toBe(true);
    expectCleanedUp();
  });

  it('does not restart the deadline when delayed headers arrive', async () => {
    let sendHeaders!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { sendHeaders = resolve; }));
    const outcome = vi.fn();
    void api.health(caller.signal).then(outcome, outcome);

    await vi.advanceTimersByTimeAsync(6_000);
    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
    sendHeaders(streamingResponse(signal, 200).response);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(outcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: 'Error', message: 'Request timed out after 10000ms',
    }));
    expectCleanedUp();
  });

  it.each([200, 503])('preserves caller cancellation during a %i body', async (status) => {
    fetchMock.mockImplementation((_url: unknown, init: RequestInit) =>
      streamingResponse(init.signal!, status).response,
    );
    const outcome = vi.fn();
    void api.health(caller.signal).then(outcome, outcome);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(outcome).not.toHaveBeenCalled();

    const reason = new DOMException('User left the page', 'AbortError');
    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toHaveBeenCalledExactlyOnceWith(reason);
    expectCleanedUp();
  });

  it('waits for a streamed success and releases its listener and deadline', async () => {
    let body!: ReturnType<typeof streamingResponse>;
    fetchMock.mockImplementation((_url: unknown, init: RequestInit) => {
      body = streamingResponse(init.signal!, 200);
      return body.response;
    });
    const outcome = vi.fn();
    void api.health(caller.signal).then(outcome, outcome);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(outcome).not.toHaveBeenCalled();
    body.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expectCleanedUp();

    caller.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(false);
  });

  it('cleans up after a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>nope</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(api.health(caller.signal)).rejects.toMatchObject({
      name: 'ApiError', status: 502, code: null, message: 'Bad Gateway',
    });
    expectCleanedUp();
  });

  it('preserves the 401 code and requestId and cleans up', async () => {
    fetchMock.mockResolvedValue(json({
      error: { code: 'unauthorized', message: 'invalid key', requestId: 'req_auth' },
    }, 401));
    await expect(api.health(caller.signal)).rejects.toMatchObject({
      name: 'ApiError', status: 401, code: 'unauthorized', message: 'invalid key', requestId: 'req_auth',
    });
    expectCleanedUp();
  });

  it('cleans up after malformed success JSON', async () => {
    fetchMock.mockResolvedValue(new Response('invalid JSON'));
    await expect(api.health(caller.signal)).rejects.toBeInstanceOf(SyntaxError);
    expectCleanedUp();
  });

  it('preserves a fetch failure and cleans up', async () => {
    const error = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(error);
    await expect(api.health(caller.signal)).rejects.toBe(error);
    expectCleanedUp();
  });

  it('cleans up after timing out before headers', async () => {
    fetchMock.mockImplementation((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const outcome = vi.fn();
    void api.health(caller.signal).then(outcome, outcome);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: 'Error', message: 'Request timed out after 10000ms',
    }));
    expectCleanedUp();
  });

  it('does not dispatch fetch or allocate resources for a pre-canceled request', async () => {
    caller.abort();
    await expect(api.health(caller.signal)).rejects.toBe(caller.signal.reason);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
