import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const beforeId = resolve(repository, 'src/store/__curves_browser_base__.tsx');
const before = execFileSync('git', ['show', '9ec8b331:src/store/useUIStore.ts'], { cwd: repository, encoding: 'utf8' });
export default defineConfig({
  root: repository,
  plugins: [
    {
      name: 'exact-base-ui-store',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'virtual:base-ui') return beforeId;
      },
      load(id) {
        if (id === beforeId) return before;
      },
    },
    tailwindcss(),
    react(),
  ],
  optimizeDeps: { entries: ['checks/curves-panel/index.html'], exclude: ['virtual:base-ui'] },
  server: { host: '127.0.0.1', port: Number(process.env.CURVES_PORT ?? 9143), strictPort: true },
  clearScreen: false,
});
