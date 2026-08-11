import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyPrompt } from '../src/App';
import { api, ApiError, getApiKey, setApiKey } from '../src/api/client';
import { classifyConnectionError, getConnection, recordConnectionError, resetConnection } from '../src/api/hooks';

describe('dashboard API key authentication', () => {
  afterEach(() => {
    setApiKey(null);
    resetConnection();
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

  it('renders a token input and submit control for unauthorized access', () => {
    const markup = renderToStaticMarkup(
      <ApiKeyPrompt source="none" onSubmit={vi.fn()} onClear={vi.fn()} />,
    );

    expect(markup).toContain('需要 API key');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('type="submit"');
  });
});
