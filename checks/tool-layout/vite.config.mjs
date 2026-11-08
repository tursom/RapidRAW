import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const beforeId = resolve(repository, 'src/store/__tool_layout_task3__.tsx');
const selectorsId = resolve(repository, 'checks/tool-layout/__canvas_selectors__.ts');
const maskId = resolve(repository, 'checks/tool-layout/__mask_visibility__.ts');
const speedId = resolve(repository, 'src/components/panel/editor/overlays/__tool_layout_task3_speed__.tsx');
const before = execFileSync('git', ['show', '33ba1eb7:src/store/useUIStore.ts'], { cwd: repository, encoding: 'utf8' });
const canvasPath = 'src/components/panel/editor/ImageCanvas.tsx';
const maskPath = 'src/components/panel/right/MasksPanel.tsx';
function maskSelector(source) {
  const parsed = ts.createSourceFile(maskPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some((entry) => entry.name.getText(parsed) === 'isAdjustmentsPanelVisible')
    ) {
      const call = node.initializer;
      if (!call || !ts.isCallExpression(call) || call.expression.getText(parsed) !== 'useUIStore')
        throw new Error('Unexpected Masks selector');
      const shallow = call.arguments[0];
      if (!ts.isCallExpression(shallow) || shallow.expression.getText(parsed) !== 'useShallow')
        throw new Error('Unexpected Masks shallow selector');
      callback = shallow.arguments[0].getText(parsed);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!callback) throw new Error('Missing Masks waveform visibility selector');
  return callback;
}
// Extract the actual useUIStore callback AST, rather than reimplementing its condition.
function selectors(source, name) {
  const parsed = ts.createSourceFile(canvasPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = {};
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ['isCenterMarkerSectionOpen', 'isRelightToolOpen'].includes(node.name.text)
    ) {
      if (
        !node.initializer ||
        !ts.isCallExpression(node.initializer) ||
        node.initializer.expression.getText(parsed) !== 'useUIStore'
      )
        throw new Error(`Unexpected production selector ${node.name.text}`);
      found[node.name.text] = node.initializer.arguments[0].getText(parsed);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (Object.keys(found).length !== 2) throw new Error('Missing production canvas selectors');
  return `export const ${name} = (state: UIState) => ({ center: (${found.isCenterMarkerSectionOpen})(state), relight: (${found.isRelightToolOpen})(state) });`;
}
export default defineConfig({
  root: repository,
  plugins: [
    {
      name: 'task4-focused-controls',
      enforce: 'pre',
      resolveId(id) {
        if ([beforeId, speedId, selectorsId, maskId].includes(id)) return id;
        if (id === 'virtual:task3-ui') return beforeId;
        if (id === 'virtual:canvas-selectors') return selectorsId;
        if (id === 'virtual:task3-speed-edit') return speedId;
        if (id === 'virtual:mask-visibility') return maskId;
      },
      load(id) {
        if (id === beforeId) return before;
        if (id === maskId) {
          const source = readFileSync(resolve(repository, maskPath), 'utf8');
          const base = execFileSync('git', ['show', `33ba1eb7:${maskPath}`], { cwd: repository, encoding: 'utf8' });
          return `import { isPanelVisible as currentVisible, type UIState } from '../../src/store/useUIStore';
            import { isPanelVisible as beforeVisible } from 'virtual:task3-ui';
            import { Panel } from '../../src/components/ui/AppProperties';
            const makeCurrent = (isPanelVisible: typeof currentVisible) => (${maskSelector(source)});
            const makeBefore = (isPanelVisible: typeof currentVisible) => (${maskSelector(base)});
            export const current = (state: UIState) => makeCurrent(currentVisible)(state).isAdjustmentsPanelVisible;
            export const task3 = (state: UIState) => makeBefore(beforeVisible)(state).isAdjustmentsPanelVisible;`;
        }
        if (id === speedId)
          return execFileSync('git', ['show', '33ba1eb7:src/components/panel/editor/overlays/SpeedEditOverlay.tsx'], {
            cwd: repository,
            encoding: 'utf8',
          });
        if (id === selectorsId) {
          const current = readFileSync(resolve(repository, canvasPath), 'utf8');
          const base = execFileSync('git', ['show', `33ba1eb7:${canvasPath}`], { cwd: repository, encoding: 'utf8' });
          return `import { isPanelVisible, type UIState } from '../../src/store/useUIStore';
          import { Panel } from '../../src/components/ui/AppProperties';
          import { isHistoryMode } from '../../src/utils/appMode';
          import { CENTER_MARKERS } from '../../src/components/panel/editor/overlays/CenterMarkerShape';
          const activeCenterMarker = Object.keys(CENTER_MARKERS)[0] as keyof typeof CENTER_MARKERS;
          ${selectors(current, 'current')}\n${selectors(base, 'task3')}`;
        }
      },
    },
    tailwindcss(),
    react(),
  ],
  optimizeDeps: {
    entries: ['checks/tool-layout/index.html'],
    exclude: ['virtual:task3-ui', 'virtual:canvas-selectors', 'virtual:task3-speed-edit', 'virtual:mask-visibility'],
  },
  server: { host: '127.0.0.1', port: Number(process.env.TOOL_LAYOUT_PORT ?? 9144), strictPort: true },
  clearScreen: false,
});
