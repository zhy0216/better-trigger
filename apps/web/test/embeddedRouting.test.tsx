import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('BASE_URL', '/operations/workflows/');
  vi.stubEnv('VITE_BT_API_KEY_ENV_NAME', 'HOST_WORKFLOW_TOKEN');
});

import App from '../src/App';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';

beforeEach(() => {
  setApiKey(null);
  resetConnection();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
    runs: [], nextCursor: null, tasks: [], workers: [], schedules: [],
  })))));
  window.history.replaceState(null, '', '/operations/workflows/tasks');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('preserves the mount path for deep links, navigation and browser history', async () => {
  render(<App />);
  await waitFor(() => expect(screen.getByRole('main', { name: 'Tasks' })).toBeTruthy());
  expect(window.location.pathname).toBe('/operations/workflows/tasks');

  fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
  await waitFor(() => expect(screen.getByRole('main', { name: 'Runs' })).toBeTruthy());
  expect(window.location.pathname).toBe('/operations/workflows/runs');

  window.history.back();
  await waitFor(() => expect(screen.getByRole('main', { name: 'Tasks' })).toBeTruthy());
  expect(window.location.pathname).toBe('/operations/workflows/tasks');
});

it('uses the host-provided variable name in the API key prompt', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))));
  render(<App />);
  await waitFor(() => expect(screen.getByText('HOST_WORKFLOW_TOKEN')).toBeTruthy());
});
