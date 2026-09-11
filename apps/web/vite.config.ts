import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
  },
  test: {
    // The dashboard tests render React components; jsdom is the default test
    // environment so a test file cannot silently fall into node (p2-34).
    environment: 'jsdom',
  },
});
