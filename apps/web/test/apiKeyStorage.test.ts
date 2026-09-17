import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const reloadClient = async () => {
  vi.resetModules();
  return import('../src/api/client');
};

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_BT_API_KEY', undefined);
  vi.stubEnv('VITE_BT_API_KEY_STORAGE_KEY', undefined);
  vi.stubEnv('VITE_BT_API_URL', '/dashboard');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

it('restores an entered key after reload and removes it when forgotten', async () => {
  const client = await reloadClient();
  client.setApiKey('  remembered-token  ');

  const reloaded = await reloadClient();
  expect(reloaded.getApiKey()).toBe('remembered-token');
  expect(reloaded.getApiKeySource()).toBe('local-storage');
  reloaded.setApiKey(null);

  const forgotten = await reloadClient();
  expect(forgotten.getApiKey()).toBeNull();
  expect(forgotten.getApiKeySource()).toBe('none');
});

it('keeps tokens separate for different API endpoints', async () => {
  (await reloadClient()).setApiKey('first-endpoint-token');
  vi.stubEnv('VITE_BT_API_URL', '/another-dashboard');
  const other = await reloadClient();
  expect(other.getApiKey()).toBeNull();
  other.setApiKey('other-endpoint-token');

  vi.stubEnv('VITE_BT_API_URL', '/dashboard');
  expect((await reloadClient()).getApiKey()).toBe('first-endpoint-token');
});

it('supports a host-defined storage key', async () => {
  vi.stubEnv('VITE_BT_API_KEY_STORAGE_KEY', 'host:workflow:api-key');
  localStorage.setItem('host:workflow:api-key', 'existing-token');
  const client = await reloadClient();
  expect(client.getApiKey()).toBe('existing-token');
  client.setApiKey('replacement-token');
  expect(localStorage.getItem('host:workflow:api-key')).toBe('replacement-token');
});

it('prefers the development build key over a remembered key', async () => {
  (await reloadClient()).setApiKey('stored-token');
  vi.stubEnv('VITE_BT_API_KEY', '  development-token  ');
  const client = await reloadClient();
  expect(client.getApiKey()).toBe('development-token');
  expect(client.getApiKeySource()).toBe('vite-env');
});

it('remains usable in memory when browser storage is unavailable', async () => {
  const unavailable = () => { throw new Error('Storage unavailable'); };
  vi.stubGlobal('localStorage', { getItem: unavailable, setItem: unavailable, removeItem: unavailable });
  const client = await reloadClient();
  expect(client.getApiKey()).toBeNull();
  client.setApiKey('temporary-token');
  expect(client.getApiKey()).toBe('temporary-token');
  expect(client.getApiKeySource()).toBe('memory');
  client.setApiKey(null);
  expect(client.getApiKey()).toBeNull();
});
