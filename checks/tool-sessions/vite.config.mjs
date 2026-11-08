import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const controls = new Map([
  ['virtual:task4-actions', 'src/hooks/useEditorActions.ts'],
  ['virtual:task4-keyboard', 'src/hooks/useKeyboardShortcuts.ts'],
]);
const resolved = new Map(
  [...controls].map(([id, path]) => [id, resolve(repository, path.replace(/\.ts$/, '.__task5_base__.ts'))]),
);
export default defineConfig({
  root: repository,
  plugins: [
    {
      name: 'task5-focused-negative-controls',
      enforce: 'pre',
      resolveId(id) {
        return resolved.get(id);
      },
      load(id) {
        for (const [virtual, path] of controls) {
          if (resolved.get(virtual) !== id) continue;
          const source = execFileSync('git', ['show', `fbb76a9f:${path}`], {
            cwd: repository,
            encoding: 'utf8',
          });
          return virtual === 'virtual:task4-keyboard'
            ? source.replace("from './useEditorActions'", "from 'virtual:task4-actions'")
            : source;
        }
      },
    },
    tailwindcss(),
    react(),
  ],
  optimizeDeps: { entries: ['checks/tool-sessions/index.html'], exclude: [...controls.keys()] },
  server: { host: '127.0.0.1', port: Number(process.env.TOOL_SESSIONS_PORT ?? 9145), strictPort: true, hmr: false },
  clearScreen: false,
});
