import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyPrompt } from '../src/App';
import { api, ApiError, getApiKey, setApiKey } from '../src/api/client';
import { classifyConnectionError, getConnection, recordConnectionError, resetConnection, useSchedules, useTasks, useWorkers } from '../src/api/hooks';

describe('dashboard API key authentication', () => {
  afterEach(() => {
    cleanup();
    setApiKey(null);
    resetConnection();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('adds the in-memory key as a Bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, version: 'test' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setApiKey('secret-token');

    await api.health();

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer secret-token' },
    });
  });

  it('does not write the key to browser storage', () => {
    const storageWrites = vi.fn();
    vi.stubGlobal('localStorage', { setItem: storageWrites });
    vi.stubGlobal('sessionStorage', { setItem: storageWrites });

    setApiKey('memory-only');

    expect(getApiKey()).toBe('memory-only');
    expect(storageWrites).not.toHaveBeenCalled();
  });

  it('classifies an API 401 separately from a network failure', () => {
    expect(classifyConnectionError(new ApiError(401, 'invalid key'))).toBe('unauthorized');
    expect(classifyConnectionError(new TypeError('Failed to fetch'))).toBe('down');
  });

  it('parses the unauthorized code from a real 401 envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'invalid key' } }), { status: 401 }),
    ));

    await expect(api.health()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    recordConnectionError(new ApiError(401, 'invalid key', 'unauthorized'));
    expect(getConnection()).toBe('unauthorized');
  });

  it('resets the connection so a newly mounted dashboard can retry with the token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, version: 'test' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.health()).rejects.toBeInstanceOf(ApiError);
    resetConnection();
    expect(getConnection()).toBe('connecting');
    setApiKey('correct-token');
    await expect(api.health()).resolves.toEqual({ ok: true, version: 'test' });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: 'Bearer correct-token' } });
  });

  it('keeps an incorrect token unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 }),
    ));
    setApiKey('wrong-token');

    await expect(api.health()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(classifyConnectionError(new ApiError(401, 'invalid key'))).toBe('unauthorized');
  });

  it('removes the Authorization header when the key is cleared', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ ok: true, version: 'test' }), { status: 200 }),
    ));
    vi.stubGlobal('fetch', fetchMock);
    setApiKey('temporary-token');
    await api.health();
    setApiKey(null);
    await api.health();

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: undefined });
  });

  describe.each([
    { name: 'tasks', useRead: useTasks },
    { name: 'schedules', useRead: useSchedules },
    { name: 'workers', useRead: useWorkers },
  ])('$name credentials and pending heads', ({ name, useRead }) => {
    it.each(['key-b', null])('drops old data/errors and ignores a retired 401 after switching to %s', async (key) => {
      vi.useFakeTimers();
      setApiKey('key-a');
      let resolveOld!: (response: Response) => void;
      let resolveNew!: (response: Response) => void;
      const oldHead = new Promise<Response>((resolve) => { resolveOld = resolve; });
      const newHead = new Promise<Response>((resolve) => { resolveNew = resolve; });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ [name]: [] })))
        .mockRejectedValueOnce(new Error('old poll error'))
        .mockReturnValueOnce(oldHead).mockReturnValueOnce(newHead);
      vi.stubGlobal('fetch', fetchMock);
      const { result } = renderHook(() => useRead('prod'));
      await act(async () => {});
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(result.current).toMatchObject({ data: [], error: 'old poll error' });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      act(() => { setApiKey(key); });
      expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
      expect(result.current).toMatchObject({ data: null, loading: true, error: null });
      expect(fetchMock.mock.calls[3][1].headers?.Authorization).toBe(key ? 'Bearer key-b' : undefined);
      await act(async () => {
        resolveOld(new Response(JSON.stringify({ error: { message: 'old key rejected' } }), { status: 401 }));
      });
      expect(result.current).toMatchObject({ data: null, loading: true, error: null });
      expect(getConnection()).toBe('connecting');
      await act(async () => { resolveNew(new Response(JSON.stringify({ [name]: [] }))); });
      expect(result.current).toMatchObject({ data: [], loading: false, error: null });
      expect(getConnection()).toBe('live');
    });
  });

  it('renders a token input and submit control for unauthorized access', () => {
    const markup = renderToStaticMarkup(
      <ApiKeyPrompt source="none" token="" keyRejected={false} onChangeToken={vi.fn()} onSubmit={vi.fn()} onClear={vi.fn()} />,
    );

    expect(markup).toContain('Enter your API key');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('type="submit"');
  });

  it('renders the rejected variant with the typed token preserved', () => {
    const markup = renderToStaticMarkup(
      <ApiKeyPrompt source="memory" token="wrong-token" keyRejected onChangeToken={vi.fn()} onSubmit={vi.fn()} onClear={vi.fn()} />,
    );

    expect(markup).toContain('That key was rejected');
    expect(markup).toContain('value="wrong-token"');
  });
});
