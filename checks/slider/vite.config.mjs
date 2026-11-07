import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const oldId = resolve(repository, 'src/components/ui/__slider_before__.tsx');
const oldSource = process.env.SLIDER_OLD_SOURCE
  ? readFileSync(process.env.SLIDER_OLD_SOURCE, 'utf8')
  : execFileSync('git', ['show', '72dc3ec9:src/components/ui/Slider.tsx'], {
      cwd: repository,
      encoding: 'utf8',
    });

export default defineConfig({
  root: repository,
  plugins: [
    {
      name: 'slider-exact-before-source',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'virtual:slider-before' || id === oldId || id === '/src/components/ui/__slider_before__.tsx') {
          return oldId;
        }
      },
      load(id) {
        // The virtual file lives beside Slider, so its relative imports resolve to real src.
        if (id === oldId) return oldSource;
      },
    },
    tailwindcss(),
    react(),
  ],
  optimizeDeps: { entries: ['checks/slider/index.html'], exclude: ['virtual:slider-before'] },
  server: { host: '127.0.0.1', port: 9142, strictPort: true },
  clearScreen: false,
});
