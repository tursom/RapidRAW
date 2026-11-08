import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, inflateSync } from 'node:zlib';
import ts from 'typescript';
import { buildNativeSupplement } from './supplement.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const argument = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith('--'), `${flag} requires a value`);
  return value;
};
const frozen = process.argv.includes('--parent-frozen');
const development = process.argv.includes('--dev');
const requestedOutput = argument('--output');
const freezePath = argument('--freeze');
const inputsPath = argument('--inputs');
const filter = argument('--case') ?? process.env.TOOL_SESSIONS_CASE;
assert.ok(development !== frozen, 'Choose --dev, or --parent-frozen --freeze <parent manifest>');
assert.ok(
  !frozen || (freezePath && inputsPath && !filter),
  'Final run requires parent source/build manifests and every case',
);
assert.ok(!requestedOutput || (frozen && freezePath), 'Output publication requires an explicit parent freeze');
const temporary = await mkdtemp(resolve(tmpdir(), 'tool-sessions-browser-'));
const port = Number(process.env.TOOL_SESSIONS_PORT ?? 9145);
const executablePath = process.env.CHROMIUM_PATH ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const sdk = process.env.PLAYWRIGHT_MODULE ?? '/root/.npm/_npx/dd48173ecf795e2b/node_modules/playwright/index.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const parentBuildBytes = inputsPath ? await readFile(resolve(inputsPath)) : null;
const parentBuildInputs = parentBuildBytes ? JSON.parse(parentBuildBytes) : null;
if (parentBuildInputs)
  assert.ok(
    Array.isArray(parentBuildInputs.files) && parentBuildInputs.files.length,
    'Parent build inputs must contain path/sha256 files',
  );
async function filesIn(path) {
  const result = [];
  for (const item of await readdir(resolve(repository, path), { withFileTypes: true })) {
    if (['evidence', 'node_modules'].includes(item.name)) continue;
    const next = `${path}/${item.name}`;
    if (item.isDirectory()) result.push(...(await filesIn(next)));
    else result.push(next);
  }
  return result;
}
async function hashes() {
  const browserInputs = [
    'bootstrap.ts',
    'fixture.tsx',
    'host.ts',
    'virtual.d.ts',
    'fixture.css',
    'vite.config.mjs',
    'run.mjs',
    'supplement.mjs',
    'index.html',
    'tsconfig.browser.json',
  ];
  const paths = [
    ...(await filesIn('src')),
    ...(await filesIn('src-tauri/src')),
    ...browserInputs.map((file) => `checks/tool-sessions/${file}`),
    // Native validator consumes the complete gzip and binds this exact controller.
    'checks/tool-sessions/windows-smoke.py',
    ...(parentBuildInputs?.files.map((file) => file.path) ?? []),
    'package.json',
    'package-lock.json',
    'vite.config.mjs',
    'eslint.config.js',
    'tsconfig.json',
  ].sort();
  const files = {};
  for (const path of paths) files[path] = sha(await readFile(resolve(repository, path)));
  return { digest: sha(JSON.stringify(files)), files };
}
const report = {
  schema: 1,
  status: 'running',
  notnativegeneration: true,
  plannedCaseGroups: 71,
  startedAt: new Date().toISOString(),
  environment: { development, parentFrozen: frozen, hostMock: true, sdk, executablePath, platform: process.platform },
  provenance: {
    before: await hashes(),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    negativeBase: 'fbb76a9f',
    baseActionsSha256: sha(
      execFileSync('git', ['show', 'fbb76a9f:src/hooks/useEditorActions.ts'], { cwd: repository }),
    ),
    baseKeyboardSha256: sha(
      execFileSync('git', ['show', 'fbb76a9f:src/hooks/useKeyboardShortcuts.ts'], { cwd: repository }),
    ),
  },
  cases: [],
  errors: [],
  cleanup: {},
  limitations: [
    'Linux headless Chromium trusted CDP input. Not native Windows/WebView2 or Android hardware.',
    'Real ToolSessionActions, Button/i18n, stores, actions, keyboard, Slider, CurvesPanel, navigation and loader hooks.',
    'Tool mutation controls and canvas boundary are explicit fixture placeholders; no crop projection, brush drawing or full Editor/ImageCanvas.',
    'Native IPC, image decode, metadata and model task state are mocked. No AI model executes, no downloads, no generation or native saves.',
    'Focused Editor AST sibling audit plus fixture DOM geometry do not prove full canvas alignment or pixels.',
    'Task 4 actions/keyboard negative controls use current imported stores/dependencies; not a historical whole-application build.',
    'Editor paint regression uses real CSS/buttons and source-extracted Editor classes with placeholder toolbar/viewport. PNG pixels prove this minimal CSS scope, not full Editor, native Windows or WGPU rendering.',
  ],
};
if (frozen || process.argv.includes('--quality')) {
  const fixtureSources = ['fixture.tsx', 'host.ts', 'bootstrap.ts', 'virtual.d.ts'].map(
    (file) => `checks/tool-sessions/${file}`,
  );
  const lint = spawnSync(
    process.execPath,
    ['node_modules/eslint/bin/eslint.js', ...fixtureSources, '--format', 'json', '--max-warnings', '0'],
    { cwd: repository, encoding: 'utf8' },
  );
  const typecheck = spawnSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'checks/tool-sessions/tsconfig.browser.json'],
    { cwd: repository, encoding: 'utf8' },
  );
  const lintRows = JSON.parse(lint.stdout || '[]');
  const formatFiles = [
    ...fixtureSources,
    'checks/tool-sessions/fixture.css',
    'checks/tool-sessions/vite.config.mjs',
    'checks/tool-sessions/run.mjs',
    'checks/tool-sessions/supplement.mjs',
    'checks/tool-sessions/index.html',
    'checks/tool-sessions/tsconfig.browser.json',
    'checks/tool-sessions/browser.md',
  ];
  const formatting = spawnSync(
    process.execPath,
    ['node_modules/prettier/bin/prettier.cjs', '--check', ...formatFiles],
    { cwd: repository, encoding: 'utf8' },
  );
  const diagnostics = [...typecheck.stdout.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)].map((match) => ({
    path: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    code: match[4],
    message: match[5],
  }));
  report.quality = {
    prettier: { exitCode: formatting.status, stdout: formatting.stdout, stderr: formatting.stderr, files: formatFiles },
    eslint: {
      exitCode: lint.status,
      errors: lintRows.reduce((count, row) => count + row.errorCount, 0),
      warnings: lintRows.reduce((count, row) => count + row.warningCount, 0),
      records: lintRows,
      stderr: lint.stderr,
    },
    typescript: {
      exitCode: typecheck.status,
      fixtureDiagnostics: diagnostics.filter((row) => row.path.startsWith('checks/tool-sessions/')),
      importedDiagnostics: diagnostics.filter((row) => !row.path.startsWith('checks/tool-sessions/')),
      stdout: typecheck.stdout,
      stderr: typecheck.stderr,
    },
  };
  assert.ok(
    lint.status === 0 && !report.quality.eslint.errors && !report.quality.eslint.warnings,
    'Default fixture ESLint must be 0 errors / 0 warnings',
  );
  assert.ok(
    (typecheck.status === 0 || (typecheck.status === 2 && diagnostics.length)) &&
      !report.quality.typescript.fixtureDiagnostics.length,
    'Fixture must typecheck; imported production diagnostics are reported separately',
  );
  assert.equal(formatting.status, 0, 'Browser runtime and documentation must pass Prettier');
} else report.quality = { status: 'Not requested in this partial development invocation; use --quality' };
if (freezePath) {
  const bytes = await readFile(resolve(freezePath));
  const parent = JSON.parse(bytes);
  assert.ok(Array.isArray(parent.files) && parent.files.length, 'Parent freeze must contain path/sha256 files');
  const required = [
    'src/hooks/useEditorActions.ts',
    'src/hooks/useAiMasking.ts',
    'src/hooks/useKeyboardShortcuts.ts',
    'src/store/useUIStore.ts',
    'src/store/useEditorStore.ts',
    'src/components/panel/editor/ToolSessionActions.tsx',
    'src/components/panel/Editor.tsx',
    'src/components/panel/SidePanelArea.tsx',
  ];
  for (const path of required)
    assert.ok(
      parent.files.some((item) => item.path === path),
      `Freeze missing ${path}`,
    );
  for (const file of parent.files)
    assert.equal(report.provenance.before.files[file.path], file.sha256, `Parent freeze mismatch: ${file.path}`);
  report.provenance.parentFreeze = { ...parent, sha256: sha(bytes), matched: true };
}
if (parentBuildInputs) {
  for (const file of parentBuildInputs.files)
    assert.equal(report.provenance.before.files[file.path], file.sha256, `Parent build mismatch: ${file.path}`);
  report.provenance.parentBuildInputs = { ...parentBuildInputs, sha256: sha(parentBuildBytes), matched: true };
}
function focusedEditorLayout(source) {
  const parsed = ts.createSourceFile('Editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const actions = [];
  const isJsxElement = (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
  const containsCanvas = (node) => {
    let found = false;
    const visit = (child) => {
      if (ts.isJsxSelfClosingElement(child) && child.tagName.getText(parsed) === 'ImageCanvas') found = true;
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === 'ToolSessionActions') actions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(actions.length, 1, 'Exactly one real actions instance');
  const action = actions[0];
  const parent = action.parent;
  assert.ok(ts.isJsxElement(parent), 'Actions must be a JSX sibling, not inside canvas');
  assert.match(parent.openingElement.getText(parsed), /flex-col/, 'Editor flex column');
  const siblings = parent.children.filter(isJsxElement);
  const index = siblings.indexOf(action);
  assert.ok(index > 0 && containsCanvas(siblings[index - 1]), 'Actions follow viewport that contains real ImageCanvas');
  assert.match(siblings[index - 1].getText(parsed), /flex-1/, 'Canvas viewport can shrink');
  assert.ok(!containsCanvas(action));
  return {
    sourceSha256: sha(source),
    actionLine: parsed.getLineAndCharacterOfPosition(action.getStart()).line + 1,
    directSiblingAfterCanvasViewport: true,
    parentFlexColumn: true,
    fullCanvasMounted: false,
  };
}
report.provenance.editorLayout = focusedEditorLayout(
  await readFile(resolve(repository, 'src/components/panel/Editor.tsx'), 'utf8'),
);
function extractEditorPaintLayout(source) {
  const parsed = ts.createSourceFile('Editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let action;
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === 'ToolSessionActions') action = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  const environment = {
    isInstantTransition: true,
    isFullScreen: false,
    isWgpuActive: false,
    toolbarOverflowVisible: false,
    appSettings: { useWgpuRenderer: true, editorNeutralGreyBg: false },
  };
  const evaluate = (node) => {
    if (ts.isStringLiteral(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node)) {
      assert.ok(Object.hasOwn(environment, node.text), `Unrecognized Editor class input: ${node.text}`);
      return environment[node.text];
    }
    if (ts.isPropertyAccessExpression(node)) return evaluate(node.expression)?.[node.name.text];
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      return !evaluate(node.operand);
    if (ts.isConditionalExpression(node))
      return evaluate(node.condition) ? evaluate(node.whenTrue) : evaluate(node.whenFalse);
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return evaluate(node.left) && evaluate(node.right);
      if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
        return evaluate(node.left) !== evaluate(node.right);
    }
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'clsx')
      return node.arguments.map(evaluate).filter(Boolean).join(' ');
    assert.fail(`Unsupported actual Editor class expression: ${node.getText(parsed)}`);
  };
  const outer = action.parent;
  const siblings = outer.children.filter((node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node));
  const viewport = siblings[siblings.indexOf(action) - 1];
  const toolbar = siblings[siblings.indexOf(action) - 2];
  const fragments = {};
  const classOf = (node, label) => {
    assert.ok(ts.isJsxElement(node));
    const attribute = node.openingElement.attributes.properties.find(
      (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(parsed) === 'className',
    );
    assert.ok(attribute && ts.isJsxExpression(attribute.initializer));
    fragments[label] = attribute.initializer.expression.getText(parsed);
    return evaluate(attribute.initializer.expression);
  };
  const layout = {
    outerClass: classOf(outer, 'outer'),
    toolbarClass: classOf(toolbar, 'toolbar'),
    viewportClass: classOf(viewport, 'viewport'),
  };
  assert.match(layout.viewportClass, /ring-\[9999px\]/);
  assert.match(layout.viewportClass, /isolate/);
  assert.match(layout.toolbarClass, /relative z-10/);
  return {
    ...layout,
    sourceSha256: sha(source),
    environment,
    fragments,
    fullEditorMounted: false,
    wgpuRendererMounted: false,
  };
}
report.provenance.editorPaintLayout = extractEditorPaintLayout(
  await readFile(resolve(repository, 'src/components/panel/Editor.tsx'), 'utf8'),
);
// Decode our own Chromium PNG bytes with Node built-ins. No canvas readback,
// image library, downloaded dependency or generated pass flags are involved.
function screenshotPixels(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let width, height, channels;
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, '8-bit Chromium PNG');
      assert.ok([2, 6].includes(data[9]), 'RGB/RGBA Chromium PNG');
      assert.equal(data[10], 0);
      assert.equal(data[11], 0);
      assert.equal(data[12], 0);
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') chunks.push(data);
    offset += 12 + length;
  }
  const stride = width * channels,
    filtered = inflateSync(Buffer.concat(chunks));
  assert.equal(filtered.length, height * (stride + 1));
  const pixels = Buffer.alloc(height * stride);
  const paeth = (left, above, upperLeft) => {
    const predicted = left + above - upperLeft;
    const a = Math.abs(predicted - left),
      b = Math.abs(predicted - above),
      c = Math.abs(predicted - upperLeft);
    return a <= b && a <= c ? left : b <= c ? above : upperLeft;
  };
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x,
        left = x >= channels ? pixels[index - channels] : 0;
      const above = y ? pixels[index - stride] : 0,
        upperLeft = y && x >= channels ? pixels[index - stride - channels] : 0;
      const prediction = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
      pixels[index] = (filtered[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return { width, height, channels, pixels };
}
function textContrast(foreground, background) {
  const luminance = (css) => {
    const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
    assert.ok(match, `Opaque computed CSS RGB required for contrast: ${css}`);
    const linear = match.slice(1).map((value) => {
      const srgb = Number(value) / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function buttonPixels(decoded, button, ringColor) {
  const rgb = (css) => {
    const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
    assert.ok(match, `Opaque computed CSS RGB required: ${css}`);
    return match.slice(1).map(Number).join(',');
  };
  const fill = rgb(button.backgroundColor),
    text = rgb(button.color),
    ring = rgb(ringColor);
  const rect = button.rect;
  const box = {
    left: Math.ceil(rect.left),
    top: Math.ceil(rect.top),
    right: Math.floor(rect.right),
    bottom: Math.floor(rect.bottom),
  };
  assert.ok(box.left >= 0 && box.top >= 0 && box.right <= decoded.width && box.bottom <= decoded.height);
  const colors = new Map();
  for (let y = box.top; y < box.bottom; y++)
    for (let x = box.left; x < box.right; x++) {
      const index = (y * decoded.width + x) * decoded.channels;
      if (decoded.channels === 4) assert.equal(decoded.pixels[index + 3], 255);
      const color = [...decoded.pixels.subarray(index, index + 3)].join(',');
      colors.set(color, (colors.get(color) ?? 0) + 1);
    }
  const total = (box.right - box.left) * (box.bottom - box.top);
  return {
    box,
    total,
    ringRGB: ring,
    fillRGB: fill,
    textRGB: text,
    ringPixels: colors.get(ring) ?? 0,
    fillPixels: colors.get(fill) ?? 0,
    textPixels: colors.get(text) ?? 0,
    uniqueColors: colors.size,
    colors: [...colors].map(([rgb, pixels]) => ({ rgb, pixels })),
  };
}
const vite = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--config', 'checks/tool-sessions/vite.config.mjs'],
  {
    cwd: repository,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let viteLog = '';
vite.stdout.on('data', (chunk) => {
  viteLog += chunk;
});
vite.stderr.on('data', (chunk) => {
  viteLog += chunk;
});
report.environment.vitePid = vite.pid;
let browser;
let page;
let entry;
const frames = () =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const api = (method, ...args) =>
  page.evaluate(({ method, args }) => window.toolSessionsFixture[method](...args), { method, args });
const state = () => api('snapshot');
const equal = (actual, expected, label = '') => assert.deepEqual(actual, expected, label);
const tools = ['crop', 'masks', 'ai'];
const actionButton = (action) => page.locator(`[data-tool-session-action="${action}"]`);
function ownFields(adjustments, mode) {
  if (mode === 'masks') return { masks: adjustments.masks };
  if (mode === 'ai') return { aiPatches: adjustments.aiPatches };
  return Object.fromEntries(
    ['crop', 'rotation', 'flipHorizontal', 'flipVertical', 'orientationSteps', 'aspectRatio'].map((key) => [
      key,
      adjustments[key],
    ]),
  );
}
function cancelled(actual, baseline, modified, mode) {
  equal(actual.adjustments, { ...modified, ...ownFields(baseline, mode) }, 'Cancel restores only own fields');
  equal(actual.activePanel, 'adjustments');
  equal(actual.activePanels.leftBottom, 'presets');
}
async function step(name, kind, action, requiredInput = null) {
  await api('mark', name);
  const start = await api('traceLength');
  const row = { name, type: kind, trustedInputType: requiredInput, before: await state() };
  entry.steps.push(row);
  try {
    await action();
    await frames();
    row.trace = await api('trace', start);
    if (requiredInput) {
      const inputs = row.trace.filter(
        (item) => item.kind === 'input' && item.type === requiredInput && item.phase === name,
      );
      assert.ok(inputs.length, `Missing ${requiredInput} input in ${name}`);
      assert.ok(
        inputs.every((item) => item.trusted === true),
        'Input must be trusted',
      );
    }
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed';
    row.error = error.stack ?? String(error);
    throw error;
  } finally {
    row.after = await state();
    row.trace ??= await api('trace', start);
  }
}
const input = (name, type, action) => step(name, 'trusted browser input', action, type);
const setup = (name, action) => step(name, 'programmatic setup / mock boundary', action);
const observe = (name, action) => step(name, 'DOM / production state observation', action);
async function runCase(name, action, options = {}) {
  if (filter === 'native-supplement') {
    if (
      !name.includes(': busy ') &&
      name !== 'crop: A to B cold real navigation/loader rebase' &&
      name !== 'AI prompt focused: measured shared apply isolation'
    )
      return;
  } else if (filter && !name.includes(filter)) return;
  entry = { name, status: 'running', steps: [] };
  report.cases.push(entry);
  const traceStart = await api('traceLength');
  try {
    await setup('configure fixture (programmatic)', () => api('configure', options));
    await action();
    equal(
      (await api('trace', traceStart)).filter((row) =>
        ['windowError', 'rejection', 'unexpectedHost'].includes(row.kind),
      ),
      [],
    );
    entry.status = 'passed';
  } catch (error) {
    entry.status = 'failed';
    entry.error = error.stack ?? String(error);
    await page.screenshot({ path: resolve(temporary, `failure-${report.cases.length}.png`) }).catch(() => {});
  } finally {
    entry.final = await state().catch(() => null);
    await page.mouse.up();
    for (const key of ['Shift', 'Alt', 'Control', 'Meta']) await page.keyboard.up(key);
    await api('cleanup');
  }
  console.log(`${entry.status}: ${name}${entry.error ? `\n${entry.error}` : ''}`);
}
async function enter(mode) {
  await input(`enter ${mode} via fixture mode control`, 'click', async () => {
    await page.locator(`[data-mode="${mode}"]`).click();
    equal((await state()).activePanel, mode);
  });
}
async function editTool() {
  await input('fixture tool mutation (no drawing/model)', 'click', async () => {
    const before = (await state()).adjustments;
    await page.locator('#mutate-tool').click();
    assert.notDeepEqual((await state()).adjustments, before);
  });
}
async function focusCanvas() {
  await page.locator('#canvas-boundary').click();
}
async function key(name, keyName, check) {
  await input(name, 'keydown', async () => {
    await focusCanvas();
    await page.keyboard.press(keyName);
    await check();
  });
}
async function settled() {
  await page.waitForTimeout(570);
}
try {
  const start = Date.now();
  while (true) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteLog}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/checks/tool-sessions/`)).ok) break;
    } catch {}
    if (Date.now() - start > 30000) throw new Error(`Vite startup timeout: ${viteLog}`);
    await new Promise((done) => setTimeout(done, 150));
  }
  const { chromium } = await import(pathToFileURL(sdk).href);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  report.environment.browserVersion = browser.version();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(6000);
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === `http://127.0.0.1:${port}` || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    report.errors.push({ kind: 'externalRequestBlocked', url: url.href });
    return route.abort();
  });
  page.on('pageerror', (error) => report.errors.push({ kind: 'pageerror', message: error.stack }));
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push({ kind: 'console', case: entry?.name, message: message.text() });
  });
  page.on('requestfailed', (request) =>
    report.errors.push({ kind: 'requestfailed', url: request.url(), failure: request.failure() }),
  );
  await page.goto(`http://127.0.0.1:${port}/checks/tool-sessions/`, { timeout: 60000 });
  await page.waitForFunction(() => window.toolSessionsFixture && document.querySelector('#canvas-boundary'), {
    timeout: 60000,
  });

  // Run first: the hook's private request map has never received a generation request.
  // The unique persisted patch ID is installed only through resetHistory, without a task.
  await runCase('AI legacy orphan: real cancel hook releases disabled production Apply and Cancel', async () => {
    for (const action of ['apply', 'cancel']) {
      await setup(`install legacy loading without request/task before ${action}`, () => api('prepareLegacyOrphan'));
      await enter('ai');
      await observe('orphan metadata disables actual buttons without registered generation', async () => {
        const actual = await state();
        equal(actual.activeAiTasks, {});
        assert.ok(actual.adjustments.aiPatches[0].isLoading);
        equal(actual.aiSessionSnapshot.aiPatches[0].isLoading, false);
        const dom = {
          applyDisabled: await actionButton('apply').isDisabled(),
          cancelDisabled: await actionButton('cancel').isDisabled(),
        };
        equal(dom, { applyDisabled: true, cancelDisabled: true });
        const host = (await api('trace')).filter((row) => row.kind === 'hostMock');
        equal(
          host.filter((row) => String(row.cmd).startsWith('generate_')),
          [],
        );
        entry.steps.at(-1).dom = dom;
      });
      await input(`invoke existing cancel hook for orphan before ${action}`, 'click', async () => {
        const start = await api('traceLength');
        await page.locator('#cancel-task-hook').click();
        const calls = (await api('trace', start)).filter(
          (row) => row.kind === 'hostMock' && row.cmd === 'cancel_ai_task',
        );
        equal(calls.length, 1);
        equal(calls[0].args.taskId, 'legacy-orphan-patch');
        equal((await state()).activeAiTasks, {});
        equal((await state()).adjustments.aiPatches[0].isLoading, true);
        equal(await actionButton('apply').isDisabled(), true);
        equal(await actionButton('cancel').isDisabled(), true);
      });
      await setup('resolve only the explicit mock cancel IPC and await real hook cleanup', async () => {
        await api('releaseCancellation');
        await api('waitForGeneration');
      });
      await observe('real hook clears orphan and subscribed buttons reenable', async () => {
        const actual = await state();
        equal(actual.adjustments.aiPatches[0].isLoading, false);
        equal(actual.activeAiTasks, {});
        equal(actual.busy, false);
        const dom = {
          applyDisabled: await actionButton('apply').isDisabled(),
          cancelDisabled: await actionButton('cancel').isDisabled(),
        };
        equal(dom, { applyDisabled: false, cancelDisabled: false });
        entry.steps.at(-1).dom = dom;
      });
      const baseline = (await state()).adjustments;
      await editTool();
      const modified = (await state()).adjustments;
      await input(`trusted production ${action} after orphan recovery`, 'click', async () => {
        await actionButton(action).click();
        if (action === 'cancel') cancelled(await state(), baseline, modified, 'ai');
        else {
          equal((await state()).activePanel, 'adjustments');
          equal((await state()).adjustments, modified);
        }
        equal((await state()).adjustments.aiPatches[0].isLoading, false);
      });
      if (action === 'cancel') {
        await key('orphan recovery Cancel Undo retains edited content without loading', 'Control+z', async () =>
          equal((await state()).adjustments, modified),
        );
        await key('orphan recovery Cancel Redo stays clean', 'Control+y', async () =>
          cancelled(await state(), baseline, modified, 'ai'),
        );
      }
    }
  });
  for (const mode of tools) {
    await runCase(`${mode}: own fields cancel, real global slider/curve, undo/redo`, async () => {
      const baseline = (await state()).adjustments;
      await enter(mode);
      await editTool();
      await input('drag production global Slider', 'pointerdown', async () => {
        const slider = page.locator('#adjustments input[type="range"]').first();
        const bounds = await slider.boundingBox();
        assert.ok(bounds);
        const before = (await state()).adjustments.contrast;
        await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height / 2, { steps: 5 });
        await page.mouse.up();
        assert.notEqual((await state()).adjustments.contrast, before);
        equal((await state()).activePanel, mode);
      });
      await input('drag production curve point', 'mousedown', async () => {
        const curve = page.locator('#adjustments svg[viewBox="0 0 255 255"]').first();
        await curve.scrollIntoViewIfNeeded();
        const bounds = await curve.boundingBox();
        assert.ok(bounds);
        const before = (await state()).adjustments.curves;
        await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.55);
        await page.mouse.down();
        await frames();
        await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.4, { steps: 5 });
        await page.mouse.up();
        assert.notDeepEqual((await state()).adjustments.curves, before);
        equal((await state()).activePanel, mode);
      });
      const modified = (await state()).adjustments;
      await input('click real Cancel', 'click', async () => {
        await actionButton('cancel').click();
        cancelled(await state(), baseline, modified, mode);
      });
      await observe('cancel remains stable after pending debounce', async () => {
        await settled();
        cancelled(await state(), baseline, modified, mode);
      });
      const result = (await state()).adjustments;
      await key('Undo recovers cancelled tool content', 'Control+z', async () =>
        equal((await state()).adjustments, modified),
      );
      await key('Redo restores cancel result', 'Control+y', async () => equal((await state()).adjustments, result));
    });
    await runCase(`${mode}: pending debounce immediately before Cancel`, async () => {
      const baseline = (await state()).adjustments;
      await enter(mode);
      await setup('install pending production history debounce', () => api('preparePending'));
      const modified = (await state()).adjustments;
      await input('Cancel while history debounce pending', 'click', async () => {
        await actionButton('cancel').click();
        cancelled(await state(), baseline, modified, mode);
      });
      await key('immediate Undo', 'Control+z', async () => equal((await state()).adjustments, modified));
      await observe('late debounce cannot clobber Undo', async () => {
        await settled();
        equal((await state()).adjustments, modified);
      });
      await key('Redo cancelled state', 'Control+y', async () => cancelled(await state(), baseline, modified, mode));
    });
    for (const exit of ['apply', 'Enter', 'NumpadEnter', 'switch']) {
      await runCase(`${mode}: ${exit} keeps edits`, async () => {
        await enter(mode);
        await editTool();
        const modified = (await state()).adjustments;
        const check = async () => {
          equal((await state()).adjustments, modified);
          equal(
            (await state()).activePanel,
            exit === 'switch' ? tools[(tools.indexOf(mode) + 1) % tools.length] : 'adjustments',
          );
        };
        if (exit === 'apply')
          await input('click real Apply', 'click', async () => {
            await actionButton('apply').click();
            await check();
          });
        else if (exit === 'switch') {
          await enter(tools[(tools.indexOf(mode) + 1) % tools.length]);
          await check();
          await input('cancel next tool retains previous tool edits', 'click', async () => {
            await actionButton('cancel').click();
            equal((await state()).adjustments, modified);
          });
        } else await key(`apply with ${exit}`, exit, check);
      });
    }
    await runCase(`${mode}: focused Cancel Enter uses native button action`, async () => {
      const baseline = (await state()).adjustments;
      await enter(mode);
      await editTool();
      const modified = (await state()).adjustments;
      await input('Tab from Apply to Cancel then Enter', 'keydown', async () => {
        await focusCanvas();
        await page.keyboard.press('Tab');
        equal(await page.evaluate(() => document.activeElement?.getAttribute('data-tool-session-action')), 'apply');
        await page.keyboard.press('Tab');
        equal(await page.evaluate(() => document.activeElement?.getAttribute('data-tool-session-action')), 'cancel');
        await page.keyboard.press('Enter');
        cancelled(await state(), baseline, modified, mode);
      });
    });
    await runCase(`${mode}: text inputs and contenteditable isolate Enter/Escape`, async () => {
      await enter(mode);
      await editTool();
      const modified = (await state()).adjustments;
      for (const selector of ['#prompt', '#rename', '#editable']) {
        await input(`type and Enter/Escape in ${selector}`, 'keydown', async () => {
          await page.locator(selector).click();
          await page.keyboard.type('fixture text');
          await page.keyboard.press('Enter');
          await page.keyboard.press('Escape');
          equal((await state()).activePanel, mode);
          equal((await state()).adjustments, modified);
        });
      }
    });
    await runCase(`${mode}: layered Escape and outer cancellation`, async () => {
      const baseline = (await state()).adjustments;
      await enter(mode);
      await editTool();
      const modified = (await state()).adjustments;
      if (mode === 'crop') {
        await setup('straighten inner layer', () => api('setupEditor', { isStraightenActive: true }));
        await key('Escape exits straighten only', 'Escape', async () => {
          equal((await state()).isStraightenActive, false);
          equal((await state()).activePanel, mode);
          equal((await state()).adjustments, modified);
        });
      } else {
        await setup('fixture selected container and submask', () => api('setupLayer', mode));
        const [sub, container] =
          mode === 'masks'
            ? ['activeMaskId', 'activeMaskContainerId']
            : ['activeAiSubMaskId', 'activeAiPatchContainerId'];
        await key('Escape deselects submask only', 'Escape', async () => {
          equal((await state())[sub], null);
          assert.ok((await state())[container]);
          equal((await state()).activePanel, mode);
        });
        await key('Escape deselects container only', 'Escape', async () => {
          equal((await state())[container], null);
          equal((await state()).activePanel, mode);
          equal((await state()).adjustments, modified);
        });
      }
      await key('outer Escape cancels current tool', 'Escape', async () =>
        cancelled(await state(), baseline, modified, mode),
      );
    });
    for (const kind of ['isGeneratingAi', 'isGeneratingAiMask', 'maskLoading', 'aiLoading', 'activeAiTasks']) {
      await runCase(`${mode}: busy ${kind} guards buttons, Enter and outer Escape`, async () => {
        await enter(mode);
        await editTool();
        await setup(`mock busy state ${kind}`, () => api('setupBusy', kind, true));
        const busyState = await state();
        await observe('native disabled buttons', async () => {
          entry.steps.at(-1).dom = {
            applyDisabled: await actionButton('apply').isDisabled(),
            cancelDisabled: await actionButton('cancel').isDisabled(),
          };
          assert.ok(busyState.busy);
          equal(await actionButton('apply').isDisabled(), true);
          equal(await actionButton('cancel').isDisabled(), true);
        });
        for (const action of ['apply', 'cancel'])
          await input(`pointer attempt on disabled ${action}`, 'pointerdown', async () => {
            const bounds = await actionButton(action).boundingBox();
            assert.ok(bounds);
            await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            equal((await state()).activePanel, mode);
            equal((await state()).adjustments, busyState.adjustments);
          });
        for (const code of ['Enter', 'Escape'])
          await key(`busy ${code} inert`, code, async () => {
            equal((await state()).activePanel, mode);
            equal((await state()).adjustments, busyState.adjustments);
          });
        await setup('direct production action guards (not browser input)', async () => {
          await api('productionAction', 'apply');
          await api('productionAction', 'cancel');
          equal((await state()).activePanel, mode);
          equal((await state()).adjustments, busyState.adjustments);
        });
        await setup('clear mock busy and observe subscribed enable', () => api('setupBusy', kind, false));
        await observe('buttons reenabled without remount', async () => {
          equal(await actionButton('apply').isEnabled(), true);
          equal(await actionButton('cancel').isEnabled(), true);
        });
      });
    }
    for (const navigation of ['cached', 'cold']) {
      await runCase(`${mode}: A to B ${navigation} real navigation/loader rebase`, async () => {
        await enter(mode);
        await editTool();
        const originalA = (await state()).adjustments;
        await setup(`prepare B ${navigation} host/cache boundary`, () => api('prepareNavigation', navigation));
        await input(`navigate to B ${navigation}`, 'click', async () => {
          await page.locator(`#navigate-${navigation}`).click();
          await page.waitForFunction(() =>
            window.toolSessionsFixture.snapshot().selectedImage?.path.endsWith('/B.jpg'),
          );
          equal((await state()).activePanel, mode);
          if (navigation === 'cold') {
            entry.steps.at(-1).dom = {
              applyDisabled: await actionButton('apply').isDisabled(),
              cancelDisabled: await actionButton('cancel').isDisabled(),
            };
            equal((await state()).selectedImage.isReady, false);
            equal(await actionButton('apply').isDisabled(), true);
            equal(await actionButton('cancel').isDisabled(), true);
          } else equal(ownFields((await state()).adjustments, mode), ownFields(await api('seed', 21), mode));
        });
        if (navigation === 'cold') {
          const pending = (await state()).adjustments;
          for (const code of ['Enter', 'Escape'])
            await key(`loading ${code} cannot close session`, code, async () => {
              equal((await state()).activePanel, mode);
              equal((await state()).adjustments, pending);
            });
        }
        await setup('release mock metadata (cached fresh sync or cold loader)', async () => {
          await page.waitForFunction(() =>
            window.toolSessionsFixture.trace().some((row) => row.kind === 'hostMock' && row.cmd === 'load_metadata'),
          );
          await api('releaseMetadata');
          await page.waitForFunction(
            () =>
              window.toolSessionsFixture.snapshot().selectedImage?.isReady === true &&
              window.toolSessionsFixture.snapshot().adjustments.rotation === 31,
          );
        });
        const baselineB = (await state()).adjustments;
        const snap = (await state())[
          mode === 'crop' ? 'cropSessionSnapshot' : mode === 'masks' ? 'masksSessionSnapshot' : 'aiSessionSnapshot'
        ];
        assert.ok(snap.path.endsWith('/B.jpg'));
        await editTool();
        const modifiedB = (await state()).adjustments;
        await input('Cancel restores B metadata baseline, never A', 'click', async () => {
          await actionButton('cancel').click();
          cancelled(await state(), baselineB, modifiedB, mode);
          assert.notDeepEqual(ownFields((await state()).adjustments, mode), ownFields(originalA, mode));
        });
        await observe('A cache preserves applied edits', async () => {
          const saved = await api('cachedA');
          equal(saved, originalA);
        });
      });
    }
  }
  for (const mode of ['masks', 'ai']) {
    for (const completion of ['same owner', 'different image', 'same path rebase']) {
      await runCase(`${mode}: real AI hook deferred result ${completion}`, async () => {
        await enter(mode);
        await input('invoke real AI mask hook (deferred mock IPC)', 'click', async () => {
          await page.locator('#generate-hook').click();
          await page.waitForFunction(() => Object.keys(window.toolSessionsFixture.snapshot().activeAiTasks).length > 0);
          assert.ok((await state()).busy);
          equal(await actionButton('apply').isDisabled(), true);
          equal(await actionButton('cancel').isDisabled(), true);
        });
        const pending = (await state()).adjustments;
        for (const code of ['Enter', 'Escape'])
          await key(`real task ${code} cannot exit`, code, async () => {
            equal((await state()).activePanel, mode);
            equal((await state()).adjustments, pending);
          });
        if (completion === 'different image') {
          await setup('prepare cold B with reused submask IDs', () => api('prepareNavigation', 'cold'));
          await input('navigate real hook from A to B while task pending', 'click', async () => {
            await page.locator('#navigate-cold').click();
            await page.waitForFunction(() =>
              window.toolSessionsFixture.snapshot().selectedImage?.path.endsWith('/B.jpg'),
            );
          });
          await setup('release B mock metadata', async () => {
            await api('releaseMetadata');
            await page.waitForFunction(
              () =>
                window.toolSessionsFixture.snapshot().selectedImage?.isReady &&
                window.toolSessionsFixture.snapshot().adjustments.rotation === 31,
            );
          });
        } else if (completion === 'same path rebase') {
          await setup('resetHistory on same path with reused submask IDs', () => api('rebaseSameImage'));
        }
        const beforeRelease = await state();
        await setup('release deferred model stub — no model executes', async () => {
          await api('releaseGeneration');
          await api('waitForGeneration');
          await page.waitForFunction(
            () => Object.keys(window.toolSessionsFixture.snapshot().activeAiTasks).length === 0,
          );
        });
        await observe('completion owner and task cleanup', async () => {
          const actual = await state();
          equal(actual.busy, false);
          if (completion === 'same owner') {
            const containers = mode === 'masks' ? actual.adjustments.masks : actual.adjustments.aiPatches;
            equal(containers[0].subMasks[0].parameters.fixtureResult, 'deferred mock mask parameters');
          } else {
            equal(actual.adjustments, beforeRelease.adjustments, 'Stale completion cannot edit new metadata owner');
            equal(actual.history, beforeRelease.history, 'Stale completion cannot add history');
            equal(actual.historyRevision, beforeRelease.historyRevision);
          }
          equal(await actionButton('apply').isEnabled(), true);
          equal(await actionButton('cancel').isEnabled(), true);
        });
      });
    }
  }
  await runCase('AI patch: A to B to cached A cannot retain abandoned loading', async () => {
    await enter('ai');
    const baselineA = (await state()).adjustments;
    await input('invoke real direct-patch hook with deferred native stub', 'click', async () => {
      await page.locator('#patch-hook').click();
      assert.ok((await state()).adjustments.aiPatches[0].isLoading);
      equal(await actionButton('apply').isDisabled(), true);
    });
    await setup('prepare cold B metadata boundary', () => api('prepareNavigation', 'cold'));
    await input('navigate real A to B while patch pending', 'click', async () => {
      await page.locator('#navigate-cold').click();
      await page.waitForFunction(() => window.toolSessionsFixture.snapshot().selectedImage?.path.endsWith('/B.jpg'));
    });
    await setup('release B metadata', async () => {
      await api('releaseMetadata');
      await page.waitForFunction(
        () =>
          window.toolSessionsFixture.snapshot().selectedImage?.isReady &&
          window.toolSessionsFixture.snapshot().adjustments.rotation === 31,
      );
    });
    const baselineB = (await state()).adjustments;
    await setup('finish abandoned A patch while B is current', async () => {
      await api('releaseGeneration');
      await api('waitForGeneration');
      equal((await state()).adjustments, baselineB, 'Abandoned A patch never writes B');
    });
    await setup('hold A fresh metadata to inspect actual frontend cache', () => api('prepareReturnA'));
    await input('return to cached A before fresh metadata can hide loading state', 'click', async () => {
      await page.locator('#navigate-a').click();
      await page.waitForFunction(() => window.toolSessionsFixture.snapshot().selectedImage?.path.endsWith('/A.jpg'));
      equal(
        (await state()).adjustments,
        baselineA,
        'Cache must release abandoned loading without accepting stale patch',
      );
      equal(await actionButton('apply').isEnabled(), true);
      equal(await actionButton('cancel').isEnabled(), true);
    });
    await setup('release held A metadata and settle loader', () => api('releaseMetadata', 'a'));
  });
  for (const boundary of ['tool reentry', 'same path reset', 'cached return']) {
    await runCase(
      `AI pending snapshot: ${boundary} Cancel never restores loading and Undo recovers content`,
      async () => {
        await enter('ai');
        await input('real direct patch hook produces pending loading state', 'click', async () => {
          await page.locator('#patch-hook').click();
          assert.ok((await state()).adjustments.aiPatches[0].isLoading);
        });
        if (boundary === 'tool reentry') {
          await enter('masks');
          await enter('ai');
        } else if (boundary === 'same path reset') {
          await setup('production resetHistory of live pending hook state', () => api('rebasePendingImage'));
        } else {
          await setup('prepare deferred B metadata', () => api('prepareNavigation', 'cold'));
          await input('real navigation A to B with pending source patch', 'click', async () => {
            await page.locator('#navigate-cold').click();
            await page.waitForFunction(() =>
              window.toolSessionsFixture.snapshot().selectedImage?.path.endsWith('/B.jpg'),
            );
          });
          await setup('resolve B metadata', async () => {
            await api('releaseMetadata');
            await page.waitForFunction(
              () =>
                window.toolSessionsFixture.snapshot().selectedImage?.isReady &&
                window.toolSessionsFixture.snapshot().adjustments.rotation === 31,
            );
          });
          await setup('hold returning A metadata', () => api('prepareReturnA'));
          await input('real cached A rebase while original patch still pending', 'click', async () => {
            await page.locator('#navigate-a').click();
            await page.waitForFunction(() =>
              window.toolSessionsFixture.snapshot().selectedImage?.path.endsWith('/A.jpg'),
            );
            assert.ok(
              (await state()).adjustments.aiPatches[0].isLoading,
              'Actual cached loading state exercises snapshot sanitization',
            );
          });
        }
        const session = (await state()).aiSessionSnapshot;
        await observe('AI snapshot records content without transient loading', async () => {
          assert.ok(session && session.aiPatches.length);
          assert.ok(session.aiPatches.every((patch) => patch.isLoading === false));
        });
        await setup('release original deferred patch and finish real owner cleanup', async () => {
          await api('releaseGeneration');
          await api('waitForGeneration');
          equal((await state()).busy, false);
          assert.ok((await state()).adjustments.aiPatches.every((patch) => patch.isLoading === false));
        });
        const baseline = { ...(await state()).adjustments, aiPatches: session.aiPatches };
        await editTool();
        const modified = (await state()).adjustments;
        if (boundary === 'tool reentry')
          equal(modified.aiPatches[0].patchData.fixturePatch, 'deferred mock patch result');
        await input('real Cancel restores content but never transient loading', 'click', async () => {
          await actionButton('cancel').click();
          cancelled(await state(), baseline, modified, 'ai');
          equal((await state()).busy, false);
          assert.ok((await state()).adjustments.aiPatches.every((patch) => patch.isLoading === false));
        });
        await key('Undo recovers cancelled AI content with loading false', 'Control+z', async () => {
          equal((await state()).adjustments, modified);
          equal((await state()).busy, false);
        });
        await observe('late history debounce cannot resurrect loading or overwrite Undo', async () => {
          await settled();
          equal((await state()).adjustments, modified);
          equal((await state()).busy, false);
        });
        await key('Redo preserves clean cancellation result', 'Control+y', async () =>
          cancelled(await state(), baseline, modified, 'ai'),
        );
        if (boundary === 'cached return')
          await setup('release held A metadata after measured snapshot assertions', () => api('releaseMetadata', 'a'));
      },
    );
  }
  await runCase('AI prompt focused: measured shared apply isolation', async () => {
    await enter('ai');
    await editTool();
    const cdp = await page.context().newCDPSession(page);
    let calibrationScript;
    try {
      await setup('calibrate V8 shared Apply counter under explicit mock busy guard', async () => {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
        await api('setupBusy', 'isGeneratingAi', true);
        await api('productionAction', 'apply');
        const calibration = await cdp.send('Profiler.takePreciseCoverage');
        const script = calibration.result.find((script) => script.url.includes('/src/hooks/useEditorActions.ts'));
        assert.ok(script);
        const functions = script.functions.filter((fn) => fn.functionName === 'applyToolSession');
        calibrationScript = script;
        entry.steps.at(-1).applyCoverage = { rawScript: script, functions };
        assert.ok(
          functions.length && functions.some((fn) => fn.ranges.some((range) => range.count > 0)),
          'Calibration must observe the guarded real Apply call',
        );
        await api('setupBusy', 'isGeneratingAi', false);
        equal((await state()).activePanel, 'ai');
      });
      await input('trusted prompt input and Enter with V8 call counts', 'keydown', async () => {
        await page.locator('#prompt').click();
        await page.keyboard.type('fixture prompt');
        entry.steps.at(-1).dom = { inputFocused: await page.evaluate(() => document.activeElement?.id === 'prompt') };
        await page.keyboard.press('Enter');
        equal((await state()).activePanel, 'ai');
        const result = await cdp.send('Profiler.takePreciseCoverage');
        const script = result.result.find((script) => script.url.includes('/src/hooks/useEditorActions.ts'));
        assert.ok(script, 'Real actions module must be observed by V8 coverage');
        const functions = script.functions.filter((fn) => fn.functionName === 'applyToolSession');
        equal(script.scriptId, calibrationScript.scriptId, 'Apply measurement must use the calibrated script');
        // V8 omits functions with zero new executions after takePreciseCoverage resets counts.
        // Keep that empty raw result, and bind it to the positive calibration instead of inventing a zero range.
        entry.steps.at(-1).applyCoverage = {
          rawScript: script,
          functions,
          calibrationScript,
          observedCallCount: functions.reduce((count, fn) => count + fn.ranges[0].count, 0),
        };
        assert.ok(
          functions.every((fn) => fn.ranges.every((range) => range.count === 0)),
          'Focused prompt must not call shared Apply',
        );
      });
    } finally {
      await cdp.send('Profiler.stopPreciseCoverage');
      await cdp.detach();
    }
  });
  await runCase('DOM geometry and Button/i18n contracts at normal and minimum viewport', async () => {
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 800, height: 600 },
    ]) {
      await setup('set browser viewport', () => page.setViewportSize(viewport));
      for (const mode of tools) {
        await enter(mode);
        await observe('real actions below canvas boundary, visible and hittable', async () => {
          const geometry = await page.evaluate(() => {
            const canvas = document.querySelector('#canvas-boundary').getBoundingClientRect();
            const container = document.querySelector('[data-tool-session-actions]');
            const rect = container.getBoundingClientRect();
            return {
              canvasBottom: canvas.bottom,
              canvasHeight: canvas.height,
              actionsTop: rect.top,
              actionsBottom: rect.bottom,
              viewportHeight: innerHeight,
              position: getComputedStyle(container).position,
              buttons: [...container.querySelectorAll('button')].map((button) => {
                const box = button.getBoundingClientRect();
                return {
                  action: button.dataset.toolSessionAction,
                  text: button.textContent.trim(),
                  hit:
                    document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') ===
                    button,
                  tag: button.tagName,
                  type: button.type,
                  className: button.className,
                };
              }),
            };
          });
          entry.steps.at(-1).geometry = geometry;
          assert.ok(geometry.canvasHeight > 0 && geometry.actionsTop >= geometry.canvasBottom);
          assert.ok(geometry.actionsBottom <= geometry.viewportHeight);
          assert.ok(!['absolute', 'fixed'].includes(geometry.position));
          equal(
            geometry.buttons.map((button) => [button.action, button.text]),
            [
              ['apply', 'Apply'],
              ['cancel', 'Cancel'],
            ],
          );
          assert.ok(
            geometry.buttons.every((button) => button.hit && button.tag === 'BUTTON' && button.type === 'button'),
          );
          assert.match(geometry.buttons[1].className, /bg-surface/);
        });
      }
    }
  });
  await runCase(
    'no image and ordinary adjustments have no new actions',
    async () => {
      equal(await page.locator('[data-tool-session-actions]').count(), 0);
      for (const mode of tools)
        await input(`no-image fixture ${mode} entry rejected by real store`, 'click', async () => {
          await page.locator(`[data-mode="${mode}"]`).click();
          equal((await state()).activePanel, 'adjustments');
          equal(await page.locator('[data-tool-session-actions]').count(), 0);
        });
    },
    { noImage: true },
  );
  await runCase('ordinary adjustments have no new actions', async () => {
    equal(await page.locator('[data-tool-session-actions]').count(), 0);
  });
  await runCase(
    'desktop compact shows real actions for every tool',
    async () => {
      for (const mode of tools) {
        await enter(mode);
        await observe('desktop compact actions visible and enabled', async () => {
          equal(await page.locator('[data-tool-session-actions]').count(), 1);
          equal(await actionButton('apply').isEnabled(), true);
        });
        await input('compact real Apply exits tool', 'click', async () => {
          await actionButton('apply').click();
          equal((await state()).activePanel, 'adjustments');
        });
      }
    },
    { full: false },
  );
  for (const mode of tools)
    await runCase(
      `Android ${mode}: no new actions, legacy keys`,
      async () => {
        await enter(mode);
        await editTool();
        equal(await page.locator('[data-tool-session-actions]').count(), 0);
        if (mode === 'crop') {
          await key('Android Crop Enter keeps legacy apply', 'Enter', async () =>
            equal((await state()).activePanel, 'adjustments'),
          );
          await enter('crop');
          const baseline = (await state()).adjustments;
          await editTool();
          const modified = (await state()).adjustments;
          await key('Android Crop Escape keeps legacy cancel', 'Escape', async () => {
            equal((await state()).activePanel, 'adjustments');
            equal((await state()).adjustments, { ...modified, ...ownFields(baseline, 'crop') });
          });
        } else {
          await key('Android Enter does not apply Masks/AI', 'Enter', async () =>
            equal((await state()).activePanel, mode),
          );
          await key('Android outer Escape retains old external back callback', 'Escape', async () => {
            equal((await state()).activePanel, mode);
            assert.ok((await api('trace')).some((row) => row.kind === 'externalCallback' && row.name === 'back'));
          });
        }
      },
      { platform: 'android' },
    );
  await runCase(
    'Task 4 negative control rejects new Masks Enter apply assertion',
    async () => {
      await enter('masks');
      await editTool();
      await key('old keyboard Enter lacks Masks application', 'Enter', async () => {
        const actual = await state();
        assert.throws(() => equal(actual.activePanel, 'adjustments'), assert.AssertionError);
        equal(actual.activePanel, 'masks');
        entry.negativeControl = { sameApplyAssertionRejected: true, observedPanel: actual.activePanel };
      });
    },
    { legacyKeyboard: true },
  );
  await runCase('Task 4 negative control rejects immediate Undo after crop cancellation', async () => {
    await enter('crop');
    await setup('pending direct geometry edit', () => api('preparePending'));
    const modified = (await state()).adjustments;
    await setup('execute exact Task 4 cancelCrop (focused API control)', () => api('productionAction', 'task4Cancel'));
    await key('old cancellation cannot immediately Undo to edited crop', 'Control+z', async () => {
      const actual = (await state()).adjustments;
      assert.throws(() => equal(actual, modified), assert.AssertionError);
      entry.negativeControl = { sameImmediateUndoAssertionRejected: true, actual, expected: modified };
    });
  });
  await runCase(
    'SidePanelArea rapid Apply/Cancel re-entry: real presence lifecycle',
    async () => {
      const cdp = await page.context().newCDPSession(page);
      const click = async (selector) => {
        // Resolve a hittable interior point now; no animation/actionability wait.
        const point = await page.evaluate((selector) => {
          const button = document.querySelector(selector);
          if (!(button instanceof HTMLElement)) throw new Error(`Missing real button: ${selector}`);
          const rect = button.getBoundingClientRect();
          for (const fy of [0.5, 0.25, 0.75])
            for (const fx of [0.5, 0.25, 0.75]) {
              const x = rect.left + rect.width * fx;
              const y = rect.top + rect.height * fy;
              const hit = document.elementFromPoint(x, y);
              if (hit && (hit === button || button.contains(hit))) return { x, y, rect: rect.toJSON() };
            }
          return { blocked: true, rect: rect.toJSON() };
        }, selector);
        if (point.blocked) {
          // The real moving tab indicator can cover its neighbour. Activate the
          // same native button through trusted focus traversal, without waiting.
          assert.ok(selector.startsWith('[data-tab-id='), 'Action buttons must remain pointer-hittable');
          const commands = [];
          for (let index = 0; index < 20; index++) {
            if (
              await page.evaluate((selector) => document.activeElement === document.querySelector(selector), selector)
            )
              break;
            for (const type of ['keyDown', 'keyUp']) {
              const command = { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
              commands.push(command);
              await cdp.send('Input.dispatchKeyEvent', command);
            }
          }
          assert.ok(
            await page.evaluate((selector) => document.activeElement === document.querySelector(selector), selector),
          );
          for (const type of ['keyDown', 'keyUp']) {
            const command = {
              type,
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
              ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
            };
            commands.push(command);
            await cdp.send('Input.dispatchKeyEvent', command);
          }
          return { selector, point, inputMethod: 'trusted Tab traversal and native Enter activation', commands };
        }
        const commands = [
          { type: 'mouseMoved', x: point.x, y: point.y },
          { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 },
          { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 },
        ];
        for (const command of commands) await cdp.send('Input.dispatchMouseEvent', command);
        return { selector, point, inputMethod: 'trusted CDP pointer', commands };
      };
      const checkPane = (dom, mode) => {
        equal(dom.activePanel, mode);
        equal(dom.renderedPanel, mode);
        equal(dom.regionalPanel, mode);
        equal(dom.outerPanel, mode);
        equal(dom.presenceKey, mode);
        equal(dom.currentPaneKey, mode);
        equal(dom.headings.length, 1, 'Exactly one current tool heading, no stranded Presets');
        equal(dom.headings[0].panel, mode);
        equal(dom.headings[0].title, { crop: 'Crop', masks: 'Masks', ai: 'AI' }[mode]);
        assert.ok(dom.headings[0].connected && !dom.headings[0].hidden);
        assert.ok(dom.headings[0].rect.width > 0 && dom.headings[0].rect.height > 0);
      };
      try {
        for (const mode of tools)
          for (const action of ['apply', 'cancel'])
            for (const delay of [50, 100, 150, 180, 250])
              for (let repeat = 1; repeat <= 2; repeat++) {
                const label = `${mode} ${action} return ${delay}ms repeat ${repeat}`;
                await input(`baseline actual tab ${label}`, 'click', async () => {
                  entry.steps.at(-1).baselineCommand = await click(`[data-tab-id="layout-tab-${mode}"]`);
                  // Establish the initial pane before the measured exit; never wait before re-entry.
                  await page.waitForFunction((mode) => {
                    const dom = window.toolSessionsFixture.lifecycleSnapshot();
                    return (
                      dom.headings.length === 1 && dom.headings[0].panel === mode && dom.headings[0].opacity > 0.99
                    );
                  }, mode);
                  checkPane(await api('lifecycleSnapshot'), mode);
                });
                const baseline = await api('lifecycleSnapshot');
                await input(`rapid actual ${label}`, 'click', async () => {
                  const row = entry.steps.at(-1);
                  const start = await api('traceLength');
                  const exit = await click(`[data-tool-session-action="${action}"]`);
                  await new Promise((done) => setTimeout(done, delay));
                  const reenter = await click(`[data-tab-id="layout-tab-${mode}"]`);
                  await frames();
                  const immediate = await api('lifecycleSnapshot');
                  const clicks = (await api('trace', start)).filter((event) => event.kind === 'lifecycleClick');
                  row.lifecycle = { delay, repeat, mode, action, baseline, exit, reenter, clicks, immediate };
                  equal(clicks.length, 2);
                  assert.ok(clicks.every((event) => event.trusted));
                  equal(clicks[0].action, action);
                  equal(clicks[1].tab, `layout-tab-${mode}`);
                  row.lifecycle.actualClickIntervalMs = clicks[1].at - clicks[0].at;
                  checkPane(immediate, mode);
                  const oldInstance = baseline.headings[0].instance;
                  const newInstance = immediate.headings[0].instance;
                  assert.notEqual(newInstance, oldInstance, 'Re-entry mounts a new tool component');
                  assert.ok(
                    immediate.events.some((event) => event.instance === oldInstance && event.type === 'unmount'),
                  );
                  assert.ok(immediate.events.some((event) => event.instance === newInstance && event.type === 'mount'));
                  // Unconditional post-input observation; assertions above already ran without an animation wait.
                  await page.waitForTimeout(200);
                  row.lifecycle.after200ms = await api('lifecycleSnapshot');
                  checkPane(row.lifecycle.after200ms, mode);
                  assert.ok(row.lifecycle.after200ms.headings[0].opacity > 0.99);
                });
              }
      } finally {
        await cdp.detach();
      }
    },
    { realSidePanel: true },
  );
  await runCase(
    'Editor CSS actionbar paint: exact static negative control and production pixels',
    async () => {
      await setup('paint fixture viewport and fonts (programmatic)', async () => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.evaluate(() => document.fonts.ready);
      });
      for (const mode of tools)
        for (const action of ['apply', 'cancel']) {
          let negativeGeometry;
          for (const variant of ['old-static-control', 'production']) {
            // Every static control keeps the original dark ring. Production
            // Apply rows cover all three tools in dark; Cancel rows additionally
            // exercise real light/grey tokens without adding or changing groups.
            const theme =
              variant === 'production' && action === 'cancel'
                ? { crop: 'dark', masks: 'light', ai: 'grey' }[mode]
                : 'dark';
            await setup(`prepare ${mode} ${action} ${variant} class boundary`, () =>
              api('preparePaint', mode, variant, theme),
            );
            await observe(`actual PNG pixels ${mode} ${action} ${variant}`, async () => {
              const dom = await api('paintSnapshot');
              const png = await page.screenshot({ animations: 'disabled' });
              const decoded = screenshotPixels(png);
              const measured = dom.buttons.map((button) => buttonPixels(decoded, button, dom.viewport.backgroundColor));
              entry.steps.at(-1).paint = {
                mode,
                action,
                variant,
                theme,
                dom,
                measured,
                screenshot: {
                  mime: 'image/png',
                  bytes: png.length,
                  sha256: sha(png),
                  base64: png.toString('base64'),
                  width: decoded.width,
                  height: decoded.height,
                },
              };
              equal(dom.applicationCanvasMounted, false);
              equal(dom.buttons.length, 2);
              assert.ok(
                dom.buttons.every(
                  (button) =>
                    button.connected && button.hit && button.visibility === 'visible' && button.opacity === '1',
                ),
              );
              assert.ok(dom.viewport.boxShadow.includes(`${dom.viewport.backgroundColor} 0px 0px 0px 9999px`));
              const geometry = {
                actions: dom.actions.rect,
                buttons: dom.buttons.map((button) => button.rect),
                viewport: dom.viewport.rect,
              };
              if (variant === 'old-static-control') {
                equal(dom.actions.className, 'shrink-0 flex justify-center gap-3 py-2');
                equal(dom.actions.position, 'static');
                negativeGeometry = geometry;
                for (const pixels of measured) {
                  equal(pixels.uniqueColors, 1, 'Old static control must reproduce blank button pixels');
                  equal(pixels.ringPixels, pixels.total, 'Every old button pixel is the actual ring RGB');
                }
              } else {
                equal(dom.actions.className, dom.productionActionsClass);
                equal(dom.actions.position, 'relative');
                equal(dom.actions.zIndex, '10');
                equal(geometry, negativeGeometry, 'Paint fix changes no DOM geometry');
                const semantic = dom.semanticColors;
                equal(semantic.theme, theme);
                equal(
                  semantic.generatedUtilityColor,
                  semantic.resolvedTokenColor,
                  'Actual generated text utility resolves the semantic token',
                );
                assert.notEqual(
                  semantic.generatedUtilityColor,
                  semantic.probeParentColor,
                  'Utility probe must not pass through inherited body color',
                );
                equal(
                  dom.buttons[1].color,
                  semantic.resolvedTokenColor,
                  'Actual Cancel computed foreground must be text-primary',
                );
                const contrast = textContrast(dom.buttons[1].color, dom.buttons[1].backgroundColor);
                entry.steps.at(-1).paint.cancelReadability = {
                  contrastRatio: contrast,
                  minimum: 4.5,
                  foreground: dom.buttons[1].color,
                  background: dom.buttons[1].backgroundColor,
                  resolvedSemanticToken: semantic.resolvedTokenColor,
                };
                assert.ok(contrast >= 4.5, 'Actual Cancel foreground/background must meet 4.5:1 text contrast');
                for (const pixels of measured) {
                  assert.ok(
                    pixels.uniqueColors > 1 && pixels.fillPixels > 100 && pixels.textPixels > 0,
                    'Actual production screenshot must contain both button fill and text pixels',
                  );
                  assert.ok(pixels.ringPixels < pixels.total);
                }
              }
            });
            await input(`trusted real ${action} ${mode} ${variant}`, 'click', async () => {
              const before = await state();
              await actionButton(action).click();
              const after = await state();
              equal(after.activePanel, 'adjustments');
              equal(after.activePanels.leftBottom, 'presets');
              equal(after.adjustments, before.adjustments);
              equal(await page.locator('[data-tool-session-actions]').count(), 0);
            });
          }
        }
    },
    { editorPaintLayout: report.provenance.editorPaintLayout },
  );
  assert.ok(report.cases.length, 'Case filter matched nothing');
  if (frozen)
    assert.equal(report.cases.length, report.plannedCaseGroups, 'Frozen run must retain every planned case group');
} catch (error) {
  report.errors.push({ kind: 'runner', message: error.stack ?? String(error) });
} finally {
  if (page) {
    await api('cleanup')
      .then((result) => {
        report.cleanup.fixtureDebouncesCancelled = result.debouncesCancelled;
        report.cleanup.mockRequestsReleased = result.mockRequestsReleased;
      })
      .catch((error) => report.errors.push({ kind: 'fixtureCleanup', message: String(error) }));
  }
  await browser
    ?.close()
    .then(() => {
      report.cleanup.browserClosed = true;
    })
    .catch((error) => report.errors.push({ kind: 'browserCleanup', message: String(error) }));
  vite.kill('SIGTERM');
  const start = Date.now();
  while (vite.exitCode === null && vite.signalCode === null && Date.now() - start < 5000)
    await new Promise((done) => setTimeout(done, 50));
  if (vite.exitCode === null && vite.signalCode === null) vite.kill('SIGKILL');
  report.cleanup.viteExited = vite.exitCode !== null || vite.signalCode !== null;
  try {
    process.kill(vite.pid, 0);
    report.cleanup.pidGone = false;
  } catch {
    report.cleanup.pidGone = true;
  }
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    report.cleanup.portReleased = false;
  } catch {
    report.cleanup.portReleased = true;
  }
  report.provenance.after = await hashes();
  report.provenance.sourceUnchanged = report.provenance.before.digest === report.provenance.after.digest;
  report.finishedAt = new Date().toISOString();
  report.viteLog = viteLog;
}
const steps = report.cases.flatMap((item) => item.steps);
report.nativeSupplement = buildNativeSupplement(report);
const trusted = steps.filter((item) => item.trustedInputType);
report.coverage = {
  cases: report.cases.length,
  steps: steps.length,
  trustedSteps: trusted.length,
  retainedTrustedSteps: trusted.filter((item) =>
    item.trace.some(
      (row) =>
        row.kind === 'input' && row.phase === item.name && row.type === item.trustedInputType && row.trusted === true,
    ),
  ).length,
};
report.status =
  report.cases.length &&
  report.cases.every((item) => item.status === 'passed') &&
  !report.errors.length &&
  report.provenance.sourceUnchanged &&
  report.cleanup.browserClosed &&
  report.cleanup.viteExited &&
  report.cleanup.pidGone &&
  report.cleanup.portReleased &&
  report.cleanup.fixtureDebouncesCancelled &&
  report.cleanup.mockRequestsReleased &&
  (!frozen || report.nativeSupplement.complete) &&
  report.coverage.trustedSteps === report.coverage.retainedTrustedSteps
    ? 'passed'
    : 'failed';
const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
const diagnostic = resolve(temporary, 'development.json');
await writeFile(diagnostic, bytes);
if (frozen && report.status === 'passed') {
  const output = resolve(requestedOutput ?? resolve(directory, 'evidence/browser/chromium.json.gz'));
  assert.ok(output.endsWith('.json.gz'), 'Final artifact must be .json.gz');
  const compressed = gzipSync(bytes);
  const manifest = resolve(directory, 'evidence/browser/browser-manifest.json');
  const supplementPath = resolve(directory, 'evidence/browser/native-supplement.json');
  const supplementBytes = Buffer.from(`${JSON.stringify(report.nativeSupplement, null, 2)}\n`);
  for (const path of [output, manifest, supplementPath]) {
    try {
      await lstat(path);
      throw new Error(`Refuse existing publication path: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, compressed, { flag: 'wx' });
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(supplementPath, supplementBytes, { flag: 'wx' });
  await writeFile(
    manifest,
    `${JSON.stringify(
      {
        status: report.status,
        ...report.coverage,
        inputDigest: report.provenance.before.digest,
        parentFreeze: report.provenance.parentFreeze,
        artifact: output,
        compressedSha256: sha(compressed),
        rawSha256: sha(bytes),
        nativeSupplement: { path: supplementPath, sha256: sha(supplementBytes), bytes: supplementBytes.length },
        quality: {
          eslintErrors: report.quality.eslint.errors,
          eslintWarnings: report.quality.eslint.warnings,
          prettierExitCode: report.quality.prettier.exitCode,
          fixtureTypeScriptDiagnostics: report.quality.typescript.fixtureDiagnostics.length,
          importedTypeScriptDiagnostics: report.quality.typescript.importedDiagnostics.length,
        },
        browserDocumentationSha256: sha(await readFile(resolve(directory, 'browser.md'))),
        cleanup: report.cleanup,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
  console.log(`Final frozen evidence: ${output}`);
}
console.log(`${report.status}: ${diagnostic}`);
if (report.status !== 'passed') process.exitCode = 1;
