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
const temporary = await mkdtemp(resolve(tmpdir(), 'curves-browser-'));
const outputFlag = process.argv.indexOf('--output');
const requestedOutput = outputFlag < 0 ? null : resolve(process.argv[outputFlag + 1]);
const port = Number(process.env.CURVES_PORT ?? 9143);
const executablePath = process.env.CHROMIUM_PATH ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const sdk = process.env.PLAYWRIGHT_MODULE ?? '/root/.npm/_npx/dd48173ecf795e2b/node_modules/playwright/index.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function filesIn(path) {
  const result = [];
  for (const item of await readdir(resolve(repository, path), { withFileTypes: true })) {
    if (item.name === 'evidence' || item.name === 'quality' || item.name === 'node_modules') continue;
    const next = `${path}/${item.name}`;
    if (item.isDirectory()) result.push(...(await filesIn(next)));
    else if (!['windows-smoke.py', 'README.md', 'browser.md'].includes(item.name)) result.push(next);
  }
  return result;
}
async function hashes() {
  const paths = [
    ...(await filesIn('src')),
    ...(await filesIn('checks/curves-panel')),
    'src-tauri/src/app_settings.rs',
    'package.json',
    'package-lock.json',
  ];
  const map = {};
  for (const path of paths.sort()) map[path] = sha(await readFile(resolve(repository, path)));
  return { digest: sha(JSON.stringify(map)), files: map };
}
const report = {
  schema: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  environment: { executablePath, sdk, platform: process.platform, hostMock: true },
  provenance: {
    before: await hashes(),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    base: '9ec8b331',
    baseUIStoreSha256: sha(execFileSync('git', ['show', '9ec8b331:src/store/useUIStore.ts'], { cwd: repository })),
  },
  cases: [],
  errors: [],
  cleanup: {},
  limitations: [
    'Linux Chromium CDP trusted mouse/keyboard, not Windows WebView2 or Android hardware.',
    'Real React components, stores, keyboard/context-menu hooks, production CSS, DndContext and ContextMenuProvider. Full App/ImageCanvas and Crop/Masks/AI/Folder/Tether content are not mounted.',
    'No backend export validation: Tauri IPC is mocked. Dimensions/size/dialog values and export progress are controlled host data; no file is exported.',
    'Fixture supplies isFullLayout via real store.setUI and workspace state. App viewport detection and Rust defaults are statically inspected, not executed in this browser.',
    'Negative control loads exact base UI store with current imported dependencies; it is a focused baseline control, not a complete historical app build.',
  ],
};
const vite = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--config', 'checks/curves-panel/vite.config.mjs'],
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
  page.evaluate(({ method, args }) => window.curvesFixture[method](...args), { method, args });
const state = () => api('snapshot');
const curve = (root = '#left') => page.locator(`${root} svg[viewBox="0 0 255 255"]`).first();
const dialog = () => page.getByRole('dialog');
const close = () => dialog().getByRole('button', { name: 'Close', exact: true });
const headerButton = (name) => page.locator('#left').getByRole('button', { name, exact: true });
const equal = (actual, expected, label = '') => assert.deepEqual(actual, expected, label);
const modePreserved = (observation, mode) => equal(observation.activePanel, mode, 'editing mode must be preserved');

async function step(name, action, { trusted, type = 'browser' } = {}) {
  await api('mark', name);
  const before = await state();
  const start = (await api('trace')).length;
  const row = { name, type, before };
  entry.steps.push(row);
  try {
    await action();
    await frames();
    if (trusted) {
      const inputs = (await api('trace')).slice(start).filter((item) => item.kind === 'input' && item.type === trusted);
      assert.ok(inputs.length > 0, `${name}: missing ${trusted} input`);
      assert.ok(
        inputs.every((item) => item.trusted),
        `${name}: untrusted ${trusted}`,
      );
    }
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed';
    row.error = String(error);
    throw error;
  } finally {
    row.after = await state();
  }
}
async function runCase(name, action, options = {}) {
  if (process.env.CURVES_CASE && !name.includes(process.env.CURVES_CASE)) return;
  entry = { name, status: 'running', steps: [] };
  report.cases.push(entry);
  try {
    await api('configure', options);
    await frames();
    await api('mark', 'case-start', true);
    await action();
    await frames();
    const trace = await api('trace');
    assert.equal(
      trace.filter((row) => ['windowError', 'rejection', 'unexpectedHost'].includes(row.kind)).length,
      0,
      'unexpected browser/host error',
    );
    entry.status = 'passed';
  } catch (error) {
    entry.status = 'failed';
    entry.error = error.stack ?? String(error);
    await page.screenshot({ path: resolve(temporary, `failure-${report.cases.length}.png`) }).catch(() => {});
  } finally {
    entry.final = await state().catch(() => null);
    await page.mouse.up();
    for (const key of ['Shift', 'Alt', 'Control', 'Meta', 'w', 'ArrowRight', 'ArrowLeft']) await page.keyboard.up(key);
    if ((await state())?.isSpeedEditActive) await page.keyboard.press('Escape');
    await api('cleanup');
    entry.cleanupState = await state();
    entry.trace = await api('trace').catch(() => []);
  }
  console.log(`${entry.status}: ${name}${entry.error ? `\n${entry.error}` : ''}`);
}
async function drawCurve(mode) {
  const bounds = await curve().boundingBox();
  assert.ok(bounds, 'real curve SVG must exist');
  const previous = (await state()).adjustments.curves;
  await step(
    `${mode}: add and drag actual curve point`,
    async () => {
      await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.55);
      await page.mouse.down();
      await frames();
      for (const dy of [0.5, 0.45, 0.4]) {
        await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * dy);
        await frames();
        modePreserved(await state(), mode);
      }
      await page.mouse.up();
      assert.notDeepEqual((await state()).adjustments.curves, previous, 'curve must actually change');
    },
    { trusted: 'mousedown' },
  );
  const outputs = (await api('trace')).filter((row) => ['uiStore', 'editorStore'].includes(row.kind));
  assert.ok(outputs.length > 0);
  for (const output of outputs) modePreserved(output, mode);
}

try {
  const start = Date.now();
  while (true) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteLog}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/checks/curves-panel/`)).ok) break;
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
    if (message.type() === 'error') report.errors.push({ kind: 'console', message: message.text() });
  });
  page.on('requestfailed', (request) =>
    report.errors.push({ kind: 'requestfailed', url: request.url(), failure: request.failure() }),
  );
  await page.goto(`http://127.0.0.1:${port}/checks/curves-panel/`, { timeout: 60000 });
  await page.waitForFunction(() => window.curvesFixture && document.querySelector('#left svg[viewBox]'), {
    timeout: 60000,
  });

  await runCase('workspace defaults, migration, malformed saved layout and exact-base negative controls', async () => {
    await step(
      'production workspace defaults and platform boundary',
      async () => {
        const desktop = await api('workspace', null);
        equal([desktop.leftPanelWidth, desktop.rightPanelWidth, desktop.leftTopHeight], [250, 320, 340]);
        equal(desktop.activePanels.leftTop, 'curves');
        assert.ok(
          desktop.panelLayout.leftTop.includes('folderTree') && desktop.panelLayout.leftTop.includes('tethering'),
        );
        const android = await api('workspace', null, 'android');
        equal([android.leftPanelWidth, android.rightPanelWidth, android.leftTopHeight], [350, 350, 450]);
        assert.ok(!Object.values(android.panelLayout).flat().includes('curves'));
        equal(await api('isHistoryMode', 'android'), false);
        for (const platform of ['windows', 'macos', 'linux']) equal(await api('isHistoryMode', platform), true);
      },
      { type: 'production API' },
    );
    await step(
      'old custom workspace retains sizes and receives one curves entry',
      async () => {
        const old = await api('baseWorkspace', null);
        old.leftPanelWidth = 287;
        old.leftTopHeight = 999;
        const migrated = await api('workspace', old);
        equal([migrated.leftPanelWidth, migrated.leftTopHeight], [287, 999]);
        equal(migrated.activePanels.leftTop, 'curves');
        equal(
          Object.values(migrated.panelLayout)
            .flat()
            .filter((p) => p === 'curves').length,
          1,
        );
        const bad = structuredClone(old);
        bad.panelLayout.leftTop.push('unknown', 'metadata');
        bad.panelLayout.leftBottom = ['crop', 'crop'];
        bad.activePanels.leftTop = 'unknown';
        const cleaned = await api('workspace', bad);
        const panels = Object.values(cleaned.panelLayout).flat();
        equal(new Set(panels).size, panels.length);
        assert.ok(!panels.includes('unknown'));
        for (const [region, panel] of Object.entries(cleaned.activePanels))
          assert.ok(panel === null || cleaned.panelLayout[region].includes(panel));
      },
      { type: 'production API / malformed input' },
    );
    await step(
      'same critical assertions reject exact base and corrupted observations',
      async () => {
        const before = await api('baseWorkspace', null);
        assert.throws(() => equal(before.activePanels.leftTop, 'curves'), assert.AssertionError);
        assert.throws(() => equal(before.leftPanelWidth, 250), assert.AssertionError);
        equal(await api('baseRoute', 'export'), 'export');
        const beforeInteraction = await api('baseCurveInteraction', 'crop');
        assert.throws(() => modePreserved(beforeInteraction, 'crop'), assert.AssertionError);
        const damaged = structuredClone(await state());
        damaged.activePanel = 'adjustments';
        assert.throws(() => modePreserved(damaged, 'crop'), assert.AssertionError);
        entry.negativeControls = {
          baseDefault: before,
          baseExportReplacesMode: true,
          baseCurveInteraction: beforeInteraction,
          corruptedModeAssertionRejected: true,
        };
      },
      { type: 'negative control' },
    );
  });

  await runCase('default curves and Controls deduplication with all fallback states', async () => {
    equal(await page.locator('#left svg[viewBox="0 0 255 255"]').count(), 1);
    equal(await page.locator('#right svg[viewBox="0 0 255 255"]').count(), 0);
    const tabs = await page
      .locator('#left [data-layout-tab]')
      .getAttribute('data-tab-id')
      .catch(() => null);
    entry.firstTab = tabs;
    equal(
      await page.locator('#left [data-tab-id="layout-tab-metadata"], #left [data-tab-id="layout-tab-export"]').count(),
      0,
    );
    await step(
      'real FolderTree tab restores Controls curve, then real Curves tab removes duplicate',
      async () => {
        await page.locator('#left [data-tab-id="layout-tab-folderTree"]').click();
        await frames();
        equal((await state()).standalone, false);
        equal(await page.locator('#right svg[viewBox="0 0 255 255"]').count(), 1);
        await page.locator('#left [data-tab-id="layout-tab-curves"]').click();
        await frames();
        equal((await state()).standalone, true);
        equal(await page.locator('#right svg[viewBox="0 0 255 255"]').count(), 0);
      },
      { trusted: 'pointerdown' },
    );
    await step(
      'library with mounted side areas also deduplicates curves',
      async () => {
        await api('patchUI', { activeView: 'library' });
        equal((await state()).standalone, true);
        equal(await page.locator('#right svg[viewBox="0 0 255 255"]').count(), 0);
      },
      { type: 'production state / actual DOM' },
    );
    for (const [label, update] of [
      ['curves inactive', { activePanels: { ...(await state()).activePanels, leftTop: 'folderTree' } }],
      ['left hidden', { uiVisibility: { leftPanel: false, rightPanel: true, filmstrip: false } }],
      ['left collapsed under 200', { leftPanelWidth: 150 }],
      ['full screen', { isFullScreen: true }],
    ]) {
      await api('configure');
      await frames();
      await step(
        label,
        async () => {
          await api('patchUI', update);
          await frames();
          equal((await state()).standalone, false);
          // Full screen hides side areas; existence verifies Controls filtering, not visibility.
          equal(await page.locator('#right svg[viewBox="0 0 255 255"]').count(), 1);
        },
        { type: 'production state / actual DOM' },
      );
    }
  });

  for (const mode of ['crop', 'masks', 'ai'])
    await runCase(`${mode}: trusted curve interaction and setPanel preserve mode`, async () => {
      await api('setPanel', mode);
      await frames();
      await api('mark', `${mode}-interaction`, true);
      await drawCurve(mode);
      await step(
        `${mode}: setPanel(curves) and setActivePanel(curves)`,
        async () => {
          await api('setPanel', 'curves');
          equal((await state()).activePanel, mode);
          await api('setActivePanel', 'leftTop', 'curves');
          equal((await state()).activePanel, mode);
        },
        { type: 'production API' },
      );
    });

  await runCase('curve context copy/reset/paste and visibility leave mask curve unchanged', async () => {
    await api('setPanel', 'masks');
    await frames();
    const mask = (await state()).adjustments.masks;
    await api('mark', 'mask curve isolation', true);
    await drawCurve('masks');
    const edited = (await state()).adjustments.curves;
    const header = page.locator('#left .border-b').first();
    for (const action of ['Copy Curves Settings', 'Reset Curves Settings', 'Paste Curves Settings']) {
      await step(
        action,
        async () => {
          await header.click({ button: 'right' });
          await page.getByText(action, { exact: true }).click();
          await frames();
          equal((await state()).adjustments.masks, mask, 'all mask data unchanged');
          if (action.startsWith('Copy')) equal((await state()).copiedSectionAdjustments.values.curves, edited);
          if (action.startsWith('Reset')) assert.notDeepEqual((await state()).adjustments.curves, edited);
          if (action.startsWith('Paste')) equal((await state()).adjustments.curves, edited);
        },
        { trusted: 'contextmenu' },
      );
    }
    const toggle = header.locator('button').first();
    for (let i = 0; i < 2; i++)
      await step(
        `visibility toggle ${i + 1}`,
        async () => {
          const before = await api('activeTools');
          await toggle.click();
          const after = await api('activeTools');
          assert.notEqual(after.curves, before.curves);
          equal((await state()).adjustments.masks, mask);
          equal((await state()).adjustments.curves, edited);
        },
        { trusted: 'click' },
      );
    for (const row of (await api('trace')).filter((row) => row.kind === 'editorStore'))
      equal(row.adjustments.masks, mask, 'all intermediate mask outputs');
    for (const row of (await api('trace')).filter((row) => ['editorStore', 'uiStore'].includes(row.kind)))
      modePreserved(row, 'masks');
  });

  await runCase('header modals button/Escape/backdrop, pointer drag, focus trap and shortcut isolation', async () => {
    await api('setPanel', 'crop');
    await frames();
    for (const name of ['Info', 'Export']) {
      await step(
        `header ${name}`,
        async () => {
          await headerButton(name).click();
          await dialog().waitFor();
          equal((await state()).activePanel, 'crop');
          equal((await state()).panelModal, name === 'Info' ? 'metadata' : 'export');
          equal(await close().evaluate((element) => document.activeElement === element), true);
        },
        { trusted: 'click' },
      );
      await step(
        `${name} Shift+Tab/Tab stays in dialog`,
        async () => {
          await page.keyboard.press('Shift+Tab');
          equal(await dialog().evaluate((element) => element.contains(document.activeElement)), true);
          await page.keyboard.press('Tab');
          equal(await close().evaluate((element) => document.activeElement === element), true);
        },
        { trusted: 'keydown' },
      );
      await step(
        `${name} Enter and E/I/C shortcuts do not reach editor`,
        async () => {
          await dialog().focus();
          for (const key of ['Enter', 'e', 'i', 'c']) {
            await page.keyboard.press(key);
            equal((await state()).activePanel, 'crop');
            equal((await state()).panelModal, name === 'Info' ? 'metadata' : 'export');
          }
        },
        { trusted: 'keydown' },
      );
      await step(
        `${name} inner press/release outside retains dialog`,
        async () => {
          const bounds = await dialog().boundingBox();
          await page.mouse.move(bounds.x + 20, bounds.y + 50);
          await page.mouse.down();
          await page.mouse.move(2, 2, { steps: 4 });
          await page.mouse.up();
          equal(await dialog().count(), 1);
        },
        { trusted: 'pointerup' },
      );
      await step(
        `${name} close button restores header focus`,
        async () => {
          await close().click();
          equal(await dialog().count(), 0);
          equal(await headerButton(name).evaluate((element) => element === document.activeElement), true);
        },
        { trusted: 'click' },
      );
      await headerButton(name).click();
      await step(
        `${name} Escape`,
        async () => {
          await page.keyboard.press('Escape');
          equal(await dialog().count(), 0);
          equal((await state()).activePanel, 'crop');
        },
        { trusted: 'keydown' },
      );
      await headerButton(name).click();
      await step(
        `${name} backdrop`,
        async () => {
          await page.mouse.click(2, 2);
          equal(await dialog().count(), 0);
          equal((await state()).activePanel, 'crop');
        },
        { trusted: 'pointerup' },
      );
    }
    for (const row of (await api('trace')).filter((row) => ['uiStore', 'editorStore'].includes(row.kind)))
      modePreserved(row, 'crop');
  });

  await runCase(
    'real SpeedEditOverlay modal guard and cancellation of latched, held nudge and active drag',
    async () => {
      const blockedKeys = async (label) => {
        const before = (await state()).adjustments;
        await step(
          `${label}: modal blocks W and arrows`,
          async () => {
            for (const key of ['w', 'ArrowRight', 'ArrowLeft', 'w']) {
              await page.keyboard.press(key);
              await frames();
              equal((await state()).adjustments, before, 'modal keys cannot change background adjustments');
              equal((await state()).isSpeedEditActive, false);
              equal((await state()).isSliderDragging, false);
            }
          },
          { trusted: 'keydown' },
        );
      };
      for (const name of ['Info', 'Export']) {
        await step(
          `${name}: open with close button focused`,
          async () => {
            await headerButton(name).click();
            await dialog().waitFor();
            equal(await close().evaluate((element) => element === document.activeElement), true);
          },
          { trusted: 'click' },
        );
        await blockedKeys(name);
        await page.keyboard.press('Escape');
      }
      for (const variant of ['latched', 'held nudge', 'active drag']) {
        await api('configure');
        await frames();
        await page.locator('#canvas-boundary').focus();
        await step(
          `${variant}: activate real SpeedEdit with W`,
          async () => {
            if (variant === 'held nudge') await page.keyboard.down('w');
            else await page.keyboard.press('w');
            await frames();
            equal((await state()).isSpeedEditActive, true);
            assert.ok((await state()).speedEditTarget, 'real Controls Slider supplies SpeedEdit target');
          },
          { trusted: 'keydown' },
        );
        const before = (await state()).adjustments;
        if (variant === 'active drag') {
          await step(
            'active drag: trusted overlay drag changes actual adjustment',
            async () => {
              const bounds = await page.locator('#canvas-boundary').boundingBox();
              await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 150);
              await page.mouse.down();
              await page.mouse.move(bounds.x + bounds.width / 2 + 25, bounds.y + 145, { steps: 4 });
              await frames();
              equal((await state()).isSliderDragging, true);
              assert.notDeepEqual((await state()).adjustments, before);
            },
            { trusted: 'pointerdown' },
          );
          await step(
            'active drag: actual I shortcut opens modal while pointer remains held',
            async () => {
              await page.keyboard.press('i');
              await dialog().waitFor();
              equal((await state()).isSpeedEditActive, false);
              equal((await state()).isSliderDragging, false);
              const frozen = (await state()).adjustments;
              await page.mouse.move(10, 10, { steps: 4 });
              await frames();
              equal((await state()).adjustments, frozen, 'cancelled SpeedEdit drag cannot continue behind modal');
              await page.mouse.up();
            },
            { trusted: 'keydown' },
          );
        } else {
          await step(
            `${variant}: actual arrow nudge changes adjustment`,
            async () => {
              if (variant === 'held nudge') await page.keyboard.down('ArrowRight');
              else await page.keyboard.press('ArrowRight');
              await frames();
              assert.notDeepEqual((await state()).adjustments, before);
              if (variant === 'held nudge') equal((await state()).isSliderDragging, true);
            },
            { trusted: 'keydown' },
          );
          await step(
            `${variant}: opening Info cancels SpeedEdit`,
            async () => {
              await headerButton('Info').click();
              await dialog().waitFor();
              equal((await state()).isSpeedEditActive, false);
              equal((await state()).isSliderDragging, false);
              if (variant === 'held nudge') {
                await page.keyboard.up('ArrowRight');
                await page.keyboard.up('w');
                equal((await state()).isSpeedEditActive, false, 'releasing held W cannot re-latch after modal opens');
              }
            },
            { trusted: 'click' },
          );
        }
        await blockedKeys(variant);
        await page.keyboard.press('Escape');
        equal((await state()).isSpeedEditActive, false, 'modal close cannot restore a cancelled SpeedEdit latch');
      }
    },
  );

  await runCase(
    'real Export Dropdown search, Tab option selection, Escape layering and unclipped portal geometry',
    async () => {
      for (const viewport of [
        { width: 800, height: 600 },
        { width: 1280, height: 720 },
      ]) {
        await page.setViewportSize(viewport);
        await api('configure');
        await frames();
        await headerButton('Export').click();
        await dialog().waitFor();
        const trigger = dialog().getByRole('button', { name: 'Custom folder', exact: true });
        await step(
          `${viewport.width}: real destination menu geometry and hit testing`,
          async () => {
            await trigger.click();
            const menu = page.locator('[data-dropdown-menu]');
            await menu.waitFor();
            await page.waitForFunction(() => {
              const menu = document.querySelector('[data-dropdown-menu]');
              const trigger = document.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]');
              return (
                menu &&
                trigger &&
                Math.abs(menu.getBoundingClientRect().width - trigger.getBoundingClientRect().width) < 0.5
              );
            });
            equal(await menu.evaluate((element) => !!element.closest('[data-app-panel-modal]')), true);
            const bounds = await menu.boundingBox();
            const origin = await trigger.boundingBox();
            assert.ok(Math.abs(bounds.x - origin.x) < 1, 'menu uses actual viewport coordinates');
            assert.ok(
              bounds.x >= 0 &&
                bounds.y >= 0 &&
                bounds.x + bounds.width <= viewport.width &&
                bounds.y + bounds.height <= viewport.height,
            );
            for (const option of [menu.getByRole('option').first(), menu.getByRole('option').last()]) {
              await option.scrollIntoViewIfNeeded();
              equal(
                await option.evaluate((element) => {
                  const box = element.getBoundingClientRect();
                  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                  return element === hit || element.contains(hit);
                }),
                true,
                'real first/last menu option is not clipped by modal overflow',
              );
            }
            entry.steps.at(-1).bounds = { trigger: origin, menu: bounds };
          },
          { trusted: 'click' },
        );
        await step(
          `${viewport.width}: type Original and Tab reaches matching option`,
          async () => {
            await trigger.focus();
            await page.keyboard.type('Original');
            const input = dialog().getByPlaceholder('Filter options...');
            equal(await input.inputValue(), 'Original');
            equal(await input.evaluate((element) => element === document.activeElement), true);
            const option = dialog().getByRole('option', { name: 'Original image folder', exact: true });
            equal(await dialog().getByRole('option').count(), 1);
            await page.keyboard.press('Tab');
            equal(
              await option.evaluate((element) => element === document.activeElement),
              true,
              'Tab must reach portal option rather than modal close button',
            );
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => !document.querySelector('[data-dropdown-menu]'));
            equal(await dialog().count(), 1);
            equal(await dialog().getByRole('button', { name: 'Original image folder', exact: true }).count(), 1);
          },
          { trusted: 'keydown' },
        );
        await step(
          `${viewport.width}: first Escape closes menu, second closes modal`,
          async () => {
            const next = dialog().getByRole('button', { name: 'Original image folder', exact: true });
            await next.click();
            await page.keyboard.type('Custom');
            equal(await dialog().getByPlaceholder('Filter options...').inputValue(), 'Custom');
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('[data-dropdown-menu]'));
            equal(await dialog().count(), 1);
            equal(await next.evaluate((element) => document.activeElement === element), true);
            await page.keyboard.press('Escape');
            equal(await dialog().count(), 0);
          },
          { trusted: 'keydown' },
        );
      }
      await page.setViewportSize({ width: 1280, height: 720 });
    },
  );

  await runCase('real keyboard hook Info/Export and editor context-menu Export entry', async () => {
    await api('setPanel', 'ai');
    await frames();
    for (const [key, panel] of [
      ['i', 'metadata'],
      ['e', 'export'],
    ]) {
      await page.locator('#canvas-boundary').focus();
      await step(
        `real shortcut ${key}`,
        async () => {
          await page.keyboard.press(key);
          await dialog().waitFor();
          equal((await state()).panelModal, panel);
          equal((await state()).activePanel, 'ai');
        },
        { trusted: 'keydown' },
      );
      await page.keyboard.press('Escape');
    }
    await step(
      'actual editor context menu Export Image',
      async () => {
        await page.locator('#canvas-boundary').click({ button: 'right' });
        await page.getByText('Export Image', { exact: true }).click();
        await dialog().waitFor();
        equal((await state()).panelModal, 'export');
        equal((await state()).activePanel, 'ai');
      },
      { trusted: 'contextmenu' },
    );
  });

  await runCase(
    'ExportPanel modal activation dimensions/estimate, slider drag outside, shared progress reopening',
    async () => {
      await step(
        'open export using real header',
        async () => {
          await headerButton('Export').click();
          await dialog().waitFor();
        },
        { trusted: 'click' },
      );
      await page.waitForFunction(() =>
        window.curvesFixture
          .trace()
          .some((row) => row.cmd === 'estimate_export_sizes' && row.args?.exportSettings?.watermark),
      );
      const host = (await api('trace')).filter((row) => row.kind === 'hostMock');
      assert.ok(
        host.some((row) => row.cmd === 'get_image_dimensions' && row.args.path === 'C:/fixture/image.jpg'),
        'watermark preview source image dimensions',
      );
      assert.ok(
        host.some((row) => row.cmd === 'get_image_dimensions' && row.args.path === 'C:/fixture/watermark.png'),
        'watermark dimensions',
      );
      assert.ok(!Object.values((await state()).activePanels).includes('export'), 'activation only via panelModal');
      const estimate = host.filter((row) => row.cmd === 'estimate_export_sizes').at(-1);
      equal(estimate.args.paths, ['C:/fixture/image.jpg']);
      equal(estimate.args.exportSettings.watermark.path, 'C:/fixture/watermark.png');
      assert.ok(
        (await dialog()
          .getByText(/120\.56|123\.46|120\.6|123\.5/)
          .count()) > 0,
        'real estimated-size UI renders mocked bytes',
      );
      await step(
        'actual export slider drag releases on backdrop',
        async () => {
          const slider = dialog().locator('input[type="range"]').first();
          await slider.scrollIntoViewIfNeeded();
          const bounds = await slider.boundingBox();
          await page.mouse.move(bounds.x + bounds.width * 0.9, bounds.y + bounds.height / 2);
          await page.mouse.down();
          await page.mouse.move(2, 2, { steps: 8 });
          await page.mouse.up();
          equal(await dialog().count(), 1);
        },
        { trusted: 'pointerup' },
      );
      await step(
        'start actual ExportPanel handler with mocked host',
        async () => {
          await dialog()
            .getByRole('button', { name: /^Export 1 Image$|^Export Image$/ })
            .click();
          await page.waitForFunction(() => window.curvesFixture.trace().some((row) => row.cmd === 'export_images'));
          equal((await state()).exportState.status, 'exporting');
        },
        { trusted: 'click' },
      );
      await api('progress', 1, 3);
      await step(
        'close and reopen preserves real shared process-store progress',
        async () => {
          await close().click();
          equal((await state()).exportState.progress, { current: 1, total: 3 });
          await headerButton('Export').click();
          await dialog().waitFor();
          equal((await state()).exportState.progress, { current: 1, total: 3 });
          assert.ok(await dialog().getByText('Exporting… (1/3)', { exact: true }).count());
          equal((await api('trace')).filter((row) => row.cmd === 'cancel_export').length, 0);
        },
        { trusted: 'click' },
      );
      entry.mockDisclosure =
        'Export promise and progress simulated at host boundary. Tests UI invocation/persistence only; no real backend output.';
    },
  );

  await runCase('800x600 and 1280x720 custom dual-region size and real vertical resizer', async () => {
    for (const viewport of [
      { width: 800, height: 600 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(viewport);
      await api('configure');
      const current = await state();
      await api('patchUI', {
        leftTopHeight: 999,
        panelLayout: {
          ...current.panelLayout,
          leftBottom: ['presets'],
          rightTop: current.panelLayout.rightTop.filter((p) => p !== 'presets'),
        },
        activePanels: { ...current.activePanels, leftBottom: 'presets' },
      });
      await frames();
      await step(
        `${viewport.width}x${viewport.height}: two regions remain usable`,
        async () => {
          const top = page.locator('[data-panel-region="leftTop"]');
          const bottom = page.locator('[data-panel-region="leftBottom"]');
          const a = await top.boundingBox();
          const b = await bottom.boundingBox();
          const outer = await bottom.evaluate((element) => {
            const region = element.parentElement.parentElement.parentElement;
            return { height: region.getBoundingClientRect().height, minHeight: getComputedStyle(region).minHeight };
          });
          // The 250px production minimum includes the actual 49px switcher and borders.
          equal(outer.minHeight, '250px');
          assert.ok(outer.height >= 250);
          assert.ok(a.height > 0 && b.height > 0, JSON.stringify({ a, b, outer }));
          assert.ok(a.width >= 200 && b.width >= 200);
          await bottom.scrollIntoViewIfNeeded();
          const visible = await bottom.boundingBox();
          assert.ok(visible.y < viewport.height && visible.y + visible.height > 0);
          entry.steps.at(-1).bounds = { top: a, bottom: b, outerBottom: outer, visibleBottom: visible };
        },
        { type: 'actual layout geometry' },
      );
      await step(
        `${viewport.width}: real vertical split drag`,
        async () => {
          const resizer = page.locator('#left .cursor-row-resize');
          await resizer.scrollIntoViewIfNeeded();
          const bounds = await resizer.boundingBox();
          const before = (await state()).leftTopHeight;
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 4);
          await page.mouse.down();
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 35, { steps: 4 });
          await page.mouse.up();
          assert.notEqual((await state()).leftTopHeight, before);
        },
        { trusted: 'pointerdown' },
      );
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  await runCase('small-window modal bounds and actual scroll containers', async () => {
    for (const viewport of [
      { width: 800, height: 600 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(viewport);
      for (const [name, width] of [
        ['Info', 480],
        ['Export', 560],
      ]) {
        await step(
          `${viewport.width}x${viewport.height} ${name} fits viewport`,
          async () => {
            await headerButton(name).click();
            await dialog().waitFor();
            const bounds = await dialog().boundingBox();
            equal(bounds.width, width);
            assert.ok(bounds.height <= viewport.height * 0.8 + 1);
            assert.ok(
              bounds.x >= 0 &&
                bounds.y >= 0 &&
                bounds.x + bounds.width <= viewport.width &&
                bounds.y + bounds.height <= viewport.height,
            );
            entry.steps.at(-1).bounds = bounds;
            const scrollers = await dialog()
              .locator('*')
              .evaluateAll(
                (elements) =>
                  elements.filter((element) => {
                    const style = getComputedStyle(element);
                    return ['auto', 'scroll'].includes(style.overflowY) && element.scrollHeight > element.clientHeight;
                  }).length,
              );
            assert.ok(scrollers > 0, 'real modal panel has scrollable content');
            await close().click();
          },
          { trusted: 'click' },
        );
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  await runCase(
    'Android full layout preserves sidebar Info/Export and curve-in-Controls behavior',
    async () => {
      equal((await state()).standalone, false);
      equal(await api('isHistoryMode'), false);
      equal(await page.locator('#right svg[viewBox="0 0 255 255"]').count(), 1);
      equal(await page.locator('[data-tab-id="layout-tab-curves"]').count(), 0);
      for (const panel of ['metadata', 'export']) {
        await step(
          `Android sidebar ${panel}`,
          async () => {
            await page.locator(`[data-tab-id="layout-tab-${panel}"]`).click();
            equal((await state()).activePanel, panel);
            equal((await state()).panelModal, null);
            equal(await dialog().count(), 0);
          },
          { trusted: 'click' },
        );
      }
    },
    { platform: 'android' },
  );

  for (const platform of ['windows', 'android'])
    await runCase(
      `${platform} compact mobile panel entries and Controls curve fallback`,
      async () => {
        equal((await state()).standalone, false);
        equal(await page.locator('#compact svg[viewBox="0 0 255 255"]').count(), 1);
        const buttons = page.locator('#mobile-switcher button');
        equal(await buttons.count(), 7);
        for (const [index, panel] of [
          'metadata',
          'adjustments',
          'crop',
          'masks',
          'ai',
          'presets',
          'export',
        ].entries()) {
          await step(
            `mobile ${panel}`,
            async () => {
              await buttons.nth(index).click();
              equal((await state()).activePanel, panel);
              equal((await state()).panelModal, null);
            },
            { trusted: 'click' },
          );
        }
      },
      { platform, full: false },
    );

  await runCase(
    'empty image disables header Info/Export and central modal entry',
    async () => {
      equal(await headerButton('Info').isDisabled(), true);
      equal(await headerButton('Export').isDisabled(), true);
      await step(
        'store rejects no-image modal opening',
        async () => {
          for (const panel of ['metadata', 'export']) {
            await api('setPanel', panel);
            equal((await state()).panelModal, null);
          }
        },
        { type: 'production API' },
      );
    },
    { noImage: true },
  );

  await runCase('real store compact-to-full transition normalizes modal-only region activation', async () => {
    for (const panel of ['metadata', 'export']) {
      await api('configure', { full: false });
      await frames();
      await api('setPanel', panel);
      equal((await state()).activePanels.leftTop, panel);
      await step(
        `${panel}: store.setUI returns to full layout`,
        async () => {
          await api('patchUI', { isFullLayout: true });
          equal((await state()).activePanels.leftTop, 'curves');
          equal((await state()).standalone, true);
          equal(await page.locator('#left svg[viewBox="0 0 255 255"]').count(), 1);
          equal(await page.locator('#right svg[viewBox="0 0 255 255"]').count(), 0);
        },
        { type: 'production store.setUI transition / actual DOM' },
      );
    }
  });

  await runCase('App full-layout write and Rust platform defaults source-entry audit', async () => {
    const app = await readFile(resolve(repository, 'src/App.tsx'), 'utf8');
    const rust = await readFile(resolve(repository, 'src-tauri/src/app_settings.rs'), 'utf8');
    assert.match(app, /isFullLayout/);
    assert.match(app, /panelModal/);
    assert.match(app, /Panel\.Metadata/);
    assert.match(app, /Panel\.Export/);
    assert.match(rust, /left_panel_width:\s*if cfg!\(target_os = "android"\)\s*\{\s*320\s*\}\s*else\s*\{\s*250/);
    assert.match(rust, /right_panel_width:\s*320/);
    assert.match(rust, /left_top_height:\s*if cfg!\(target_os = "android"\)\s*\{\s*450\s*\}\s*else\s*\{\s*340/);
    entry.staticOnly = true;
    entry.disclosure =
      'Static source audit only. Full App responsive transition and native Rust startup are delegated to full application smoke coverage.';
  });
} catch (error) {
  report.errors.push({ kind: 'runner', message: error.stack ?? String(error) });
} finally {
  if (page) {
    await api('cleanup').catch((error) => report.errors.push({ kind: 'fixtureCleanup', message: String(error) }));
  }
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
  let viteAlive = true;
  try {
    process.kill(vite.pid, 0);
  } catch {
    viteAlive = false;
  }
  report.cleanup.viteProcessGone = !viteAlive;
  try {
    await fetch(`http://127.0.0.1:${port}/checks/curves-panel/`);
    report.cleanup.portReleased = false;
  } catch {
    report.cleanup.portReleased = true;
  }
  report.provenance.after = await hashes();
  report.provenance.unchanged = report.provenance.before.digest === report.provenance.after.digest;
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
  // Failed attempts always stay outside the repository, even when --output was requested.
  const output = report.status === 'passed' && requestedOutput ? requestedOutput : resolve(temporary, 'result.json');
  await mkdir(dirname(output), { recursive: true });
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(output, output.endsWith('.gz') ? gzipSync(content, { level: 9 }) : content);
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
