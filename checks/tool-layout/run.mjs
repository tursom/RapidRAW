import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const temporary = await mkdtemp(resolve(tmpdir(), 'tool-layout-browser-'));
const outputFlag = process.argv.indexOf('--output');
const requestedOutput = outputFlag < 0 ? null : resolve(process.argv[outputFlag + 1]);
const frozen = process.argv.includes('--parent-frozen');
const freezeFlag = process.argv.indexOf('--freeze');
const freezePath = freezeFlag < 0 ? null : resolve(process.argv[freezeFlag + 1]);
if (requestedOutput && (!frozen || process.env.TOOL_LAYOUT_CASE))
  throw new Error('Final output requires --parent-frozen and a complete run');
if (frozen && !freezePath) throw new Error('--parent-frozen requires --freeze with the parent hash manifest');
const port = Number(process.env.TOOL_LAYOUT_PORT ?? 9144);
const executablePath = process.env.CHROMIUM_PATH ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const sdk = process.env.PLAYWRIGHT_MODULE ?? '/root/.npm/_npx/dd48173ecf795e2b/node_modules/playwright/index.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
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
  const productionPaths = [
    ...(await filesIn('src')),
    ...(await filesIn('src-tauri/src')),
    'package.json',
    'package-lock.json',
    'vite.config.mjs',
    'eslint.config.js',
    'tsconfig.json',
  ];
  const fixturePaths = (await filesIn('checks/tool-layout')).filter((path) => !/\.(md|py)$/.test(path));
  const files = {};
  for (const path of [...productionPaths, ...fixturePaths].sort())
    files[path] = sha(await readFile(resolve(repository, path)));
  return { digest: sha(JSON.stringify(files)), files };
}
const report = {
  schema: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  environment: { executablePath, sdk, platform: process.platform, hostMock: true, parentFrozen: frozen },
  provenance: {
    before: await hashes(),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    negativeBase: '33ba1eb7',
    baseStoreSha256: sha(execFileSync('git', ['show', '33ba1eb7:src/store/useUIStore.ts'], { cwd: repository })),
    baseSpeedEditSha256: sha(
      execFileSync('git', ['show', '33ba1eb7:src/components/panel/editor/overlays/SpeedEditOverlay.tsx'], {
        cwd: repository,
      }),
    ),
    baseCanvasSha256: sha(
      execFileSync('git', ['show', '33ba1eb7:src/components/panel/editor/ImageCanvas.tsx'], { cwd: repository }),
    ),
    baseMasksSha256: sha(
      execFileSync('git', ['show', '33ba1eb7:src/components/panel/right/MasksPanel.tsx'], { cwd: repository }),
    ),
  },
  cases: [],
  errors: [],
  cleanup: {},
  limitations: [
    'Linux headless Chromium trusted CDP input; no Windows WebView2 or Android hardware.',
    'Current real layout components, stores, Controls/Curves, keyboard hook, CSS, DndContext and context provider. Tool/Info/Export contents are explicit placeholders; full App and ImageCanvas are not mounted.',
    'Tauri host is mocked; no native decode, crop rendering, masks drawing, AI generation, disk mutation or backend validation.',
    'Canvas proof executes extracted current production selector AST callbacks with real state, not the full canvas or hardware.',
    'Fixture supplies layout mode through production store.setUI; App viewport detection remains full-application coverage.',
    'Exact Task 3 store and selector callbacks use current dependencies; focused regression controls, not a historical application build.',
    'Production tool content usability at narrow widths is delegated to full Windows application tests.',
  ],
};
if (freezePath) {
  const bytes = await readFile(freezePath);
  const parent = JSON.parse(bytes);
  for (const file of parent.files)
    assert.equal(report.provenance.before.files[file.path], file.sha256, `Parent freeze mismatch: ${file.path}`);
  report.provenance.parentFreeze = { sha256: sha(bytes), ...parent, matched: true };
}
const vite = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--config', 'checks/tool-layout/vite.config.mjs'],
  { cwd: repository, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
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
  page.evaluate(({ method, args }) => window.toolLayoutFixture[method](...args), { method, args });
const state = () => api('snapshot');
const tab = (panel) => page.locator(`[data-tab-id="layout-tab-${panel}"]`);
const curve = () => page.locator('#left svg[viewBox="0 0 255 255"]').first();
const equal = (actual, expected, label = '') => assert.deepEqual(actual, expected, label);
const tools = ['crop', 'masks', 'ai'];
const modePreserved = (observation, mode) => equal(observation.activePanel, mode, 'global tool mode remains active');
function fixedLayout(workspace) {
  equal(workspace.panelLayout.leftBottom, ['crop', 'masks', 'ai', 'presets']);
  equal(workspace.panelLayout.rightTop, ['adjustments']);
  equal(workspace.panelLayout.rightBottom, []);
  equal(workspace.panelSwitcherPlacement.leftBottom, 'bottom');
}
async function step(name, action, trusted) {
  await api('mark', name);
  const start = (await api('trace')).length;
  const row = {
    name,
    type: trusted ? 'trusted browser input' : 'production API / DOM observation',
    trustedInputType: trusted ?? null,
    before: await state(),
  };
  entry.steps.push(row);
  try {
    await action();
    await frames();
    // Persist this step before a later mark(..., true) can reset the fixture's raw buffer.
    row.trace = (await api('trace')).slice(start);
    if (trusted) {
      const inputs = row.trace.filter((item) => item.kind === 'input' && item.type === trusted && item.phase === name);
      assert.ok(inputs.length, `missing ${trusted} input`);
      assert.ok(
        inputs.every((item) => item.trusted),
        `untrusted ${trusted} input`,
      );
    }
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed';
    row.error = String(error);
    throw error;
  } finally {
    row.after = await state();
    row.trace ??= (await api('trace')).slice(start);
  }
}
async function runCase(name, action, options = {}) {
  if (process.env.TOOL_LAYOUT_CASE && !name.includes(process.env.TOOL_LAYOUT_CASE)) return;
  entry = { name, status: 'running', steps: [] };
  report.cases.push(entry);
  try {
    await api('configure', options);
    await frames();
    await api('mark', 'case-start', true);
    await action();
    await frames();
    equal(
      (await api('trace')).filter((row) => ['windowError', 'rejection', 'unexpectedHost'].includes(row.kind)),
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
    if ((await state())?.isSpeedEditActive) await page.keyboard.press('Escape');
    await api('cleanup');
    entry.trace = await api('trace').catch(() => []);
  }
  console.log(`${entry.status}: ${name}${entry.error ? `\n${entry.error}` : ''}`);
}
async function dragTab(panel, target) {
  const a = await tab(panel).boundingBox();
  const b = await target.boundingBox();
  assert.ok(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await frames();
  await page.mouse.up();
  await frames();
}
try {
  const start = Date.now();
  while (true) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteLog}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/checks/tool-layout/`)).ok) break;
    } catch {}
    if (Date.now() - start > 30000) throw new Error(`Vite startup timeout: ${viteLog}`);
    await new Promise((done) => setTimeout(done, 150));
  }
  const { chromium } = await import(pathToFileURL(sdk).href);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  report.environment.browserVersion = browser.version();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(6000);
  page.on('pageerror', (error) => report.errors.push({ kind: 'pageerror', message: error.stack }));
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push({ kind: 'console', case: entry?.name, message: message.text() });
  });
  page.on('requestfailed', (request) =>
    report.errors.push({ kind: 'requestfailed', url: request.url(), failure: request.failure() }),
  );
  await page.goto(`http://127.0.0.1:${port}/checks/tool-layout/`, { timeout: 60000 });
  await page.waitForFunction(() => window.toolLayoutFixture && document.querySelector('#left svg[viewBox]'), {
    timeout: 60000,
  });

  await runCase(
    'fixed defaults, hostile saved layout ignored, dimensions retained, Task 3 negative controls',
    async () => {
      await step('desktop fixed defaults and saved layout', async () => {
        const defaults = await api('workspace', null);
        fixedLayout(defaults);
        equal(defaults.activePanels.leftBottom, 'presets');
        equal(defaults.activePanels.rightTop, 'adjustments');
        equal([defaults.leftPanelWidth, defaults.rightPanelWidth, defaults.leftTopHeight], [250, 320, 340]);
        assert.ok(
          ['curves', 'metadata', 'export', 'folderTree', 'tethering'].every((p) =>
            defaults.panelLayout.leftTop.includes(p),
          ),
        );
        const saved = await api('task3Workspace', null);
        Object.assign(saved, { leftPanelWidth: 287, rightPanelWidth: 378, leftTopHeight: 999, rightTopHeight: 543 });
        saved.panelLayout = {
          leftTop: ['ai'],
          leftBottom: ['adjustments'],
          rightTop: ['crop', 'metadata'],
          rightBottom: ['presets', 'masks', 'curves'],
        };
        saved.activePanels = { leftTop: 'ai', leftBottom: 'adjustments', rightTop: 'crop', rightBottom: 'masks' };
        saved.panelSwitcherPlacement = { leftTop: 'left', leftBottom: 'top', rightTop: 'bottom', rightBottom: 'left' };
        const migrated = await api('workspace', saved);
        fixedLayout(migrated);
        equal(migrated.panelLayout, defaults.panelLayout);
        equal(migrated.activePanels, defaults.activePanels);
        equal(migrated.panelSwitcherPlacement, defaults.panelSwitcherPlacement);
        equal(
          [migrated.leftPanelWidth, migrated.rightPanelWidth, migrated.leftTopHeight, migrated.rightTopHeight],
          [287, 378, 999, 543],
        );
        for (const [platform, full] of [
          ['windows', false],
          ['android', true],
          ['android', false],
        ])
          equal(
            await api('workspace', saved, platform, full),
            await api('task3Workspace', saved, platform, full),
            'legacy saved-layout reconciliation unchanged',
          );
        const before = await api('task3Workspace', saved);
        assert.throws(() => fixedLayout(before), assert.AssertionError);
        const beforeContent = await api('task3Content', 'crop');
        assert.throws(() => modePreserved(beforeContent, 'crop'), assert.AssertionError);
        entry.negativeControls = { task3LayoutRejected: before.panelLayout, task3ContentRejected: beforeContent };
      });
    },
  );
  await runCase('actual right singleton hidden, ordered left tabs and singleton left strip hidden', async () => {
    fixedLayout(await state());
    equal((await state()).activePanels.leftBottom, 'presets');
    equal(await page.locator('#right [data-layout-tab]').count(), 0);
    equal(await page.locator('#right [data-panel="adjustments"]').count(), 1);
    const order = await page
      .locator('#left [data-layout-tab]')
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id')));
    equal(
      order.slice(-4),
      ['crop', 'masks', 'ai', 'presets'].map((p) => `layout-tab-${p}`),
    );
    equal(await tab('metadata').count(), 0);
    equal(await tab('export').count(), 0);
    await step('singleton left region hides its strip', async () => {
      await api('singletonRegionSetup');
      equal(await page.locator('#left [data-layout-tab]').count(), 4);
      equal(await tab('curves').count(), 0);
      equal(await curve().count(), 1);
    });
  });
  await runCase(
    'trusted tab drag rejected and store DnD mutation rejected; Android sensor positive control',
    async () => {
      const before = await state();
      await step(
        'trusted crop tab drag to right region cannot start layout drag',
        async () => {
          await dragTab('crop', page.locator('[data-panel-region="rightTop"]'));
          const after = await state();
          equal(after.panelLayout, before.panelLayout);
          equal(after.panelSwitcherPlacement, before.panelSwitcherPlacement);
          equal(
            (await api('trace')).filter((row) => row.kind === 'dndStart'),
            [],
          );
          equal(after.activeLayoutDragItem, null);
        },
        'pointerdown',
      );
      await step('all public store drag mutation entries guarded', async () => {
        await api('attemptLayoutMutation');
        const after = await state();
        equal(after.panelLayout, before.panelLayout);
        equal(after.panelSwitcherPlacement, before.panelSwitcherPlacement);
        equal(after.activeLayoutDragItem, null);
      });
      await api('configure', { platform: 'android' });
      await frames();
      await api('mark', 'sensor positive control', true);
      await step(
        'same trusted drag activates legacy Android layout DnD sensor',
        async () => {
          await dragTab('crop', page.locator('[data-panel-region="leftTop"]'));
          assert.ok(
            (await api('trace')).some((row) => row.kind === 'dndStart'),
            'positive control must detect actual DnD',
          );
        },
        'pointerdown',
      );
    },
  );
  for (const mode of tools)
    await runCase(`${mode}: trusted slider and curve preserve global mode and mask data`, async () => {
      await step(
        'enter real tool tab',
        async () => {
          await tab(mode).click();
          equal((await state()).activePanel, mode);
          equal((await state()).activePanels.leftBottom, mode);
        },
        'click',
      );
      if (mode === 'masks') await api('patchEditor', { activeMaskContainerId: 'fixture-mask' });
      const mask = (await state()).adjustments.masks;
      await api('mark', 'mode-preservation', true);
      await step(
        'trusted right slider drag changes global adjustment',
        async () => {
          const slider = page.locator('#right input[type="range"]').first();
          await slider.scrollIntoViewIfNeeded();
          const bounds = await slider.boundingBox();
          assert.ok(bounds);
          const before = (await state()).adjustments;
          await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height / 2);
          await page.mouse.down();
          await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height / 2, { steps: 5 });
          await page.mouse.up();
          assert.notDeepEqual((await state()).adjustments, before);
          modePreserved(await state(), mode);
        },
        'pointerdown',
      );
      await step(
        'trusted focus and arrow edit retains mode',
        async () => {
          const slider = page.locator('#right input[type="range"]').first();
          await slider.focus();
          const before = (await state()).adjustments;
          await page.keyboard.press('ArrowRight');
          assert.notDeepEqual((await state()).adjustments, before);
          modePreserved(await state(), mode);
        },
        'keydown',
      );
      await step(
        'trusted actual curve point drag changes whole-image curves',
        async () => {
          await curve().scrollIntoViewIfNeeded();
          const bounds = await curve().boundingBox();
          assert.ok(bounds);
          const before = (await state()).adjustments.curves;
          await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.55);
          await page.mouse.down();
          await frames();
          for (const fraction of [0.5, 0.45, 0.4]) {
            await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * fraction);
            await frames();
            modePreserved(await state(), mode);
          }
          await page.mouse.up();
          assert.notDeepEqual((await state()).adjustments.curves, before);
        },
        'mousedown',
      );
      await step('content API entries preserve tool mode', async () => {
        await api('setActivePanel', 'rightTop', 'adjustments');
        modePreserved(await state(), mode);
        await api('setActivePanel', 'leftTop', 'curves');
        modePreserved(await state(), mode);
      });
      const outputs = (await api('trace')).filter((row) => ['uiStore', 'editorStore'].includes(row.kind));
      assert.ok(outputs.length);
      for (const row of outputs) {
        modePreserved(row, mode);
        equal(row.adjustments.masks, mask, 'mask data retained in every intermediate output');
      }
      const modified = (await state()).adjustments;
      await step(
        'choosing Presets exits to Adjustments and retains edits',
        async () => {
          await tab('presets').click();
          equal((await state()).activePanel, 'adjustments');
          equal((await state()).activePanels.leftBottom, 'presets');
          equal((await state()).adjustments, modified);
        },
        'click',
      );
      await api('setPanel', mode);
      await step('explicit setPanel Adjustments exits to regional Presets', async () => {
        await api('setPanel', 'adjustments');
        equal((await state()).activePanel, 'adjustments');
        equal((await state()).activePanels.leftBottom, 'presets');
        equal((await state()).adjustments, modified);
      });
    });
  for (const mode of tools)
    await runCase(`${mode}: real SpeedEdit W/D/A stays in selected global Controls`, async () => {
      await tab(mode).click();
      await page.locator(`[data-tool-placeholder="${mode}"]`).waitFor({ state: 'visible' });
      await frames();
      await page.locator('#canvas-boundary').focus();
      if (mode === 'masks') await api('patchEditor', { activeMaskContainerId: 'fixture-mask' });
      const masks = (await state()).adjustments.masks;
      await step(
        'select global Contrast with trusted pointer then activate real W overlay',
        async () => {
          await page.locator('#right [data-speed-edit-id="contrast"]').click();
          await page.locator('#canvas-boundary').focus();
          await page.keyboard.press('w');
          equal((await state()).isSpeedEditActive, true);
          equal((await state()).speedEditTarget.owner, 'adjustments');
          equal((await state()).speedEditTarget.label, 'Contrast');
          modePreserved(await state(), mode);
        },
        'keydown',
      );
      await step(
        'D/A cycle only global right targets, then arrow edits global value',
        async () => {
          await page.keyboard.press('d');
          equal((await state()).speedEditTarget.owner, 'adjustments');
          modePreserved(await state(), mode);
          await page.keyboard.press('a');
          equal((await state()).speedEditTarget.owner, 'adjustments');
          equal((await state()).speedEditTarget.label, 'Contrast');
          const before = (await state()).adjustments.contrast;
          await page.keyboard.press('ArrowRight');
          assert.notEqual((await state()).adjustments.contrast, before);
          equal((await state()).adjustments.masks, masks);
          modePreserved(await state(), mode);
          await page.keyboard.press('Escape');
          equal((await state()).isSpeedEditActive, false);
          modePreserved(await state(), mode);
        },
        'keydown',
      );
      entry.disclosure =
        'Current production SpeedEditOverlay and real global Controls Sliders; local tool sliders are explicit sentinel fixture Sliders writing only fixture mask data, not actual Crop/Masks/AI content.';
      await step(
        'off-list Whites retains global owner for W then A/D and nudge',
        async () => {
          await page.locator('#right [data-speed-edit-id="whites"]').click();
          await page.locator('#canvas-boundary').focus();
          await page.keyboard.press('w');
          equal((await state()).speedEditTarget.label, 'Whites');
          equal((await state()).speedEditTarget.owner, 'adjustments');
          for (const key of ['a', 'd']) {
            await page.keyboard.press(key);
            equal((await state()).speedEditTarget.owner, 'adjustments');
            modePreserved(await state(), mode);
          }
          const before = (await state()).adjustments;
          await page.keyboard.press('ArrowRight');
          assert.notDeepEqual((await state()).adjustments, before);
          equal((await state()).adjustments.masks, masks);
          await page.keyboard.press('Escape');
          modePreserved(await state(), mode);
        },
        'keydown',
      );
    });
  await runCase(
    'exact Task 3 SpeedEdit negative control detects local/global target mixing',
    async () => {
      await tab('masks').click();
      await page.locator('[data-tool-placeholder="masks"]').waitFor({ state: 'visible' });
      await frames();
      await page.locator('#canvas-boundary').focus();
      await step(
        'same trusted pointer/W/D against exact old overlay selects local scope',
        async () => {
          await page.locator('#right [data-speed-edit-id="contrast"]').click();
          await page.locator('#canvas-boundary').focus();
          await page.keyboard.press('w');
          equal((await state()).speedEditTarget.owner, 'adjustments');
          await page.keyboard.press('d');
          const target = (await state()).speedEditTarget;
          equal(target.owner, 'masks');
          assert.throws(() => equal(target.owner, 'adjustments'), assert.AssertionError);
          const before = (await state()).adjustments;
          await page.keyboard.press('ArrowRight');
          equal((await state()).adjustments.contrast, before.contrast);
          assert.notDeepEqual((await state()).adjustments.masks, before.masks);
          entry.negativeControl = { target, sameGlobalOwnerAssertionRejected: true, fixtureLocalValueChanged: true };
          await page.keyboard.press('Escape');
          await page.locator('#right [data-speed-edit-id="whites"]').click();
          await page.locator('#canvas-boundary').focus();
          await page.keyboard.press('w');
          equal((await state()).speedEditTarget.label, 'Whites');
          await page.keyboard.press('a');
          const offListTarget = (await state()).speedEditTarget;
          equal(offListTarget.owner, 'masks');
          assert.throws(() => equal(offListTarget.owner, 'adjustments'), assert.AssertionError);
          entry.negativeControl.offListWhitesRejected = offListTarget;
          await page.keyboard.press('Escape');
        },
        'keydown',
      );
    },
    { legacySpeedEdit: true },
  );
  await runCase('actual keyboard hook R/M/K/P/D and collapsed-left entry reopens correct region', async () => {
    for (const [key, panel, regional] of [
      ['r', 'crop', 'crop'],
      ['m', 'masks', 'masks'],
      ['k', 'ai', 'ai'],
      ['p', 'adjustments', 'presets'],
      ['r', 'crop', 'crop'],
      ['d', 'adjustments', 'presets'],
    ]) {
      await page.locator('#canvas-boundary').focus();
      await step(
        `real hook ${key}`,
        async () => {
          await page.keyboard.press(key);
          equal((await state()).activePanel, panel);
          equal((await state()).activePanels.leftBottom, regional);
        },
        'keydown',
      );
    }
    for (const mode of ['hidden', 'collapsed']) {
      await api('patchUI', {
        leftPanelWidth: 100,
        uiVisibility: { leftPanel: mode !== 'hidden', rightPanel: true, filmstrip: false },
      });
      await page.locator('#canvas-boundary').focus();
      await step(
        `${mode} left R shortcut reopens`,
        async () => {
          await page.keyboard.press('r');
          const s = await state();
          equal(s.activePanel, 'crop');
          equal(s.activePanels.leftBottom, 'crop');
          equal(s.uiVisibility.leftPanel, true);
          assert.ok(s.leftPanelWidth >= 250);
          equal(await page.locator('#left [data-tool-placeholder="crop"]').count(), 1);
        },
        'keydown',
      );
      await api('setPanel', 'adjustments');
    }
  });
  await runCase(
    'no image native disabled DOM and rejected tab/API/keyboard entry',
    async () => {
      for (const panel of tools) {
        const button = tab(panel);
        equal(await button.isDisabled(), true);
        equal(await button.evaluate((node) => node instanceof HTMLButtonElement && node.disabled), true);
        await step(
          `disabled ${panel} trusted click attempt`,
          async () => {
            const bounds = await button.boundingBox();
            await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            equal((await state()).activePanel, 'adjustments');
            equal((await state()).activePanels.leftBottom, 'presets');
          },
          'pointerdown',
        );
        await api('setPanel', panel);
        await api('setActivePanel', 'leftBottom', panel);
        equal((await state()).activePanel, 'adjustments');
        equal((await state()).activePanels.leftBottom, 'presets');
      }
      for (const key of ['r', 'm', 'k']) {
        await page.locator('#canvas-boundary').focus();
        await step(
          `no image hook ${key} rejected`,
          async () => {
            await page.keyboard.press(key);
            equal((await state()).activePanel, 'adjustments');
            equal((await state()).activePanels.leftBottom, 'presets');
          },
          'keydown',
        );
      }
      equal(await tab('presets').isDisabled(), false);
    },
    { noImage: true },
  );
  await runCase('selected image loss resets each tool and crop session', async () => {
    for (const panel of tools) {
      await api('configure');
      await api('setPanel', panel);
      equal((await state()).activePanel, panel);
      await step(`${panel} selectedImage becomes null`, async () => {
        await api('patchEditor', { selectedImage: null });
        const s = await state();
        equal(s.activePanel, 'adjustments');
        equal(s.activePanels.leftBottom, 'presets');
        equal(s.cropSessionSnapshot, null);
        for (const tool of tools) equal(await tab(tool).isDisabled(), true);
      });
    }
  });
  for (const platform of ['windows', 'android'])
    await runCase(
      `${platform} compact mobile paths and round-trip layout`,
      async () => {
        const base = await api('task3Workspace', null, platform, false);
        const current = await api('workspace', null, platform, false);
        equal(current, base);
        equal(await page.locator('#compact svg[viewBox="0 0 255 255"]').count(), 1);
        const buttons = page.locator('#mobile-switcher button');
        equal(await buttons.count(), 7);
        for (const [index, panel] of ['metadata', 'adjustments', 'crop', 'masks', 'ai', 'presets', 'export'].entries())
          await step(
            `mobile ${panel}`,
            async () => {
              await buttons.nth(index).click();
              equal((await state()).activePanel, panel);
              equal((await state()).panelModal, null);
            },
            'click',
          );
        for (const panel of ['crop', 'masks', 'ai', 'presets', 'metadata']) {
          await api('setPanel', panel);
          await step(`${panel} compact to full to compact`, async () => {
            await api('patchUI', { isFullLayout: true });
            const s = await state();
            if (platform === 'windows') {
              fixedLayout(s);
              equal(s.activePanel, tools.includes(panel) ? panel : 'adjustments');
              equal(s.activePanels.leftBottom, tools.includes(panel) ? panel : 'presets');
            }
            await api('patchUI', { isFullLayout: false });
            if (platform === 'windows')
              equal((await state()).activePanel, tools.includes(panel) ? panel : 'adjustments');
            else equal((await state()).activePanel, panel);
          });
        }
        await api('configure', { platform, full: false, noImage: true });
        await frames();
        for (const index of [2, 3, 4]) {
          equal(
            await buttons.nth(index).isDisabled(),
            false,
            'compact native buttons retain original behavior without image',
          );
          await buttons.nth(index).click();
          equal((await state()).activePanel, tools[index - 2]);
        }
      },
      { platform, full: false },
    );
  await runCase(
    'Android full workspace and tool behavior equal Task 3 original paths',
    async () => {
      equal(await api('workspace', null, 'android', true), await api('task3Workspace', null, 'android', true));
      equal(await page.locator('#right svg[viewBox="0 0 255 255"]').count(), 1);
      for (const panel of ['crop', 'masks', 'ai', 'presets', 'metadata', 'export'])
        await step(
          `Android original ${panel} tab`,
          async () => {
            await tab(panel).click();
            equal((await state()).activePanel, panel);
            equal((await state()).panelModal, null);
          },
          'click',
        );
      await api('patchEditor', { selectedImage: null });
      equal((await state()).activePanel, 'export');
      for (const panel of tools) equal(await tab(panel).isDisabled(), false);
    },
    { platform: 'android' },
  );
  await runCase('250px tabs fit, minimum dual-region geometry, scrolling and trusted divider drag', async () => {
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 800, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await api('configure');
      await api('patchUI', { leftPanelWidth: 250, leftTopHeight: 999 });
      await frames();
      await step(`${viewport.width}x${viewport.height} dual region >=250 and tabs fit`, async () => {
        const geometry = await page.locator('#left').evaluate((left) => {
          const region = (name) =>
            left.querySelector(`[data-panel-region="${name}"]`).parentElement.parentElement.parentElement;
          const top = region('leftTop');
          const bottom = region('leftBottom');
          const scroll = top.parentElement;
          const tabs = [...left.querySelectorAll('[data-layout-tab]')].filter((tab) =>
            ['crop', 'masks', 'ai', 'presets'].some((p) => tab.getAttribute('data-tab-id') === `layout-tab-${p}`),
          );
          const strip = tabs[0].parentElement;
          const box = strip.getBoundingClientRect();
          return {
            top: top.getBoundingClientRect().height,
            bottom: bottom.getBoundingClientRect().height,
            minTop: getComputedStyle(top).minHeight,
            minBottom: getComputedStyle(bottom).minHeight,
            overflow: getComputedStyle(scroll).overflowY,
            scrollHeight: scroll.scrollHeight,
            clientHeight: scroll.clientHeight,
            stripWidth: box.width,
            stripScrollWidth: strip.scrollWidth,
            tabsFit: tabs.every((tab) => {
              const b = tab.getBoundingClientRect();
              return b.x >= box.x && b.right <= box.right + 0.5;
            }),
          };
        });
        assert.ok(geometry.top >= 250 && geometry.bottom >= 250, JSON.stringify(geometry));
        equal(geometry.minTop, '250px');
        equal(geometry.minBottom, '250px');
        equal(geometry.tabsFit, true);
        assert.ok(geometry.stripScrollWidth <= geometry.stripWidth + 1);
        entry.steps.at(-1).geometry = geometry;
        // Force total min-heights above the available height: production outer scroller must expose both.
        await page.locator('#left').evaluate((left) => {
          left.style.height = '440px';
        });
        await frames();
        const scrollable = await page
          .locator('#left .overflow-y-auto')
          .first()
          .evaluate((node) => ({
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
            overflow: getComputedStyle(node).overflowY,
          }));
        assert.ok(scrollable.scrollHeight > scrollable.clientHeight);
        equal(scrollable.overflow, 'auto');
        await tab('presets').scrollIntoViewIfNeeded();
        assert.ok(await tab('presets').isVisible());
        entry.steps.at(-1).forcedShortScroller = scrollable;
        await page.locator('#left').evaluate((left) => {
          left.style.height = '';
        });
      });
      await step(
        `${viewport.width} actual divider drag`,
        async () => {
          await api('patchUI', { leftTopHeight: 340 });
          await frames();
          const divider = page.locator('#left .cursor-row-resize');
          await divider.scrollIntoViewIfNeeded();
          const bounds = await divider.boundingBox();
          const before = (await state()).leftTopHeight;
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.down();
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 35, { steps: 5 });
          await page.mouse.up();
          assert.notEqual((await state()).leftTopHeight, before);
          assert.ok((await state()).leftTopHeight >= 250);
        },
        'pointerdown',
      );
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  });
  await runCase(
    'actual MasksPanel waveform visibility selector follows compact panel with Task 3 negative control',
    async () => {
      await api('setPanel', 'masks');
      await step('full Adjustments visible disables Masks waveform by actual selector', async () => {
        equal(await api('maskVisibility'), true);
        equal(await api('maskVisibility', true), true);
      });
      await api('patchUI', { isFullLayout: false });
      await frames();
      await step('compact Masks enables waveform despite stale regional Adjustments', async () => {
        equal(await page.locator('#right').count(), 0);
        equal((await state()).activePanels.rightTop, 'adjustments');
        equal((await state()).activePanel, 'masks');
        equal(await api('maskVisibility'), false);
        const previous = await api('maskVisibility', true);
        equal(previous, true);
        assert.throws(() => equal(previous, false), assert.AssertionError);
        entry.negativeControl = {
          staleRegionalRight: (await state()).activePanels.rightTop,
          task3Visible: previous,
          currentVisible: false,
        };
      });
      const mobile = page.locator('#mobile-switcher button');
      await step(
        'trusted compact Adjustments then Masks changes selector with actual rendered region',
        async () => {
          await mobile.nth(1).click();
          equal((await page.locator('#compact input[type="range"]').count()) > 0, true);
          equal(await api('maskVisibility'), true);
          await mobile.nth(3).click();
          equal((await state()).activePanel, 'masks');
          equal(await api('maskVisibility'), false);
        },
        'click',
      );
      for (const full of [true, false]) {
        await api('configure', { platform: 'android', full });
        await api('setPanel', 'masks');
        equal(await api('maskVisibility'), await api('maskVisibility', true), 'Android regional predicate unchanged');
      }
      entry.disclosure =
        'Executes actual MasksPanel shallow selector AST with current/Task 3 isPanelVisible; MasksPanel button/waveform itself is not mounted, so native toggle/drawing remain Windows coverage.';
    },
  );
  await runCase(
    'focused actual ImageCanvas selectors exclude tools with positive and Task 3 negative controls',
    async () => {
      await api('patchUI', {
        collapsibleSectionsState: { basic: true, color: true, curves: true, details: true, effects: true },
      });
      await step('actual production selector positive control and mode guards', async () => {
        equal(await api('selectors'), { center: true, relight: true });
        for (const mode of tools) {
          await api('setPanel', mode);
          const actual = await api('selectors');
          equal(actual, { center: false, relight: false });
          const old = await api('selectors', true);
          equal(old, { center: true, relight: true });
          assert.throws(() => equal(old, { center: false, relight: false }), assert.AssertionError);
        }
        await api('setPanel', 'adjustments');
        equal(await api('selectors'), { center: true, relight: true });
        await api('patchUI', { uiVisibility: { leftPanel: true, rightPanel: false, filmstrip: false } });
        equal(await api('selectors'), { center: false, relight: false });
        for (const [platform, full] of [
          ['windows', false],
          ['android', true],
          ['android', false],
        ]) {
          await api('configure', { platform, full });
          await api('patchUI', {
            collapsibleSectionsState: { basic: true, color: true, curves: true, details: true, effects: true },
          });
          for (const mode of tools) {
            await api('setPanel', mode);
            equal(await api('selectors'), await api('selectors', true), 'compact/Android selector semantics unchanged');
          }
        }
      });
      entry.disclosure =
        'Focused selector callbacks extracted from current ImageCanvas AST; no rendered canvas, image pixels, drawing or hardware proof.';
    },
  );
} catch (error) {
  report.errors.push({ kind: 'runner', message: error.stack ?? String(error) });
} finally {
  if (page)
    await api('cleanup').catch((error) => report.errors.push({ kind: 'fixtureCleanup', message: String(error) }));
  if (browser) {
    await browser.close();
    report.cleanup.browserClosed = true;
  }
  vite.kill('SIGTERM');
  await new Promise((done) => {
    if (vite.exitCode !== null) done();
    else {
      const timer = setTimeout(done, 5000);
      vite.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    }
  });
  if (vite.exitCode === null && vite.signalCode === null) vite.kill('SIGKILL');
  report.cleanup.viteExitCode = vite.exitCode;
  report.cleanup.viteSignalCode = vite.signalCode;
  let alive = true;
  try {
    process.kill(vite.pid, 0);
  } catch {
    alive = false;
  }
  report.cleanup.viteProcessGone = !alive;
  try {
    await fetch(`http://127.0.0.1:${port}/checks/tool-layout/`);
    report.cleanup.portReleased = false;
  } catch {
    report.cleanup.portReleased = true;
  }
  report.provenance.after = await hashes();
  report.provenance.unchanged = report.provenance.before.digest === report.provenance.after.digest;
  const trustedSteps = report.cases
    .flatMap((item) => item.steps)
    .filter((item) => item.type === 'trusted browser input');
  const retainedSteps = trustedSteps.filter((item) => {
    const inputs =
      item.trace?.filter(
        (event) => event.kind === 'input' && event.type === item.trustedInputType && event.phase === item.name,
      ) ?? [];
    return inputs.length > 0 && inputs.every((event) => event.trusted === true);
  });
  report.traceRetention = {
    trustedSteps: trustedSteps.length,
    retainedSteps: retainedSteps.length,
    complete: trustedSteps.length === retainedSteps.length,
  };
  if (!report.traceRetention.complete)
    report.errors.push({ kind: 'traceRetention', message: 'A trusted step lacks persisted phase-matched raw input' });
  report.status =
    report.cases.length &&
    report.cases.every((item) => item.status === 'passed') &&
    !report.errors.length &&
    report.provenance.unchanged &&
    report.cleanup.viteProcessGone &&
    report.cleanup.portReleased
      ? 'passed'
      : 'failed';
  report.finishedAt = new Date().toISOString();
  report.temporary = temporary;
  const output = report.status === 'passed' && requestedOutput ? requestedOutput : resolve(temporary, 'result.json');
  await mkdir(dirname(output), { recursive: true });
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(output, output.endsWith('.gz') ? gzipSync(content, { level: 9 }) : content, { flag: 'wx' });
  await writeFile(resolve(temporary, 'vite.log'), viteLog);
  console.log(
    JSON.stringify(
      {
        status: report.status,
        cases: report.cases.length,
        failed: report.cases.filter((item) => item.status === 'failed').map((item) => item.name),
        errors: report.errors,
        sourceUnchanged: report.provenance.unchanged,
        output,
        viteLog: resolve(temporary, 'vite.log'),
      },
      null,
      2,
    ),
  );
  if (report.status !== 'passed') process.exitCode = 1;
}
