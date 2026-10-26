import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const apiPort = Number(process.env.BANKPILOT_DELIVERY_API_PORT);
const webPort = Number(process.env.BANKPILOT_DELIVERY_WEB_PORT);
const envDir = process.env.BANKPILOT_DELIVERY_ENV_DIR;
if (!envDir || [apiPort, webPort].some(port => !Number.isSafeInteger(port) || port < 1024 || port > 65535 || [55432, 8787, 5178].includes(port))) throw new Error('DELIVERY_WEB_CONFIG_INVALID');
export default defineConfig({
  root: resolve('apps/web'), envDir, plugins: [react()],
  server: { host: '127.0.0.1', port: webPort, strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } },
});
