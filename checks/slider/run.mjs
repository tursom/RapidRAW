import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const sdk = process.env.PLAYWRIGHT_MODULE ?? '/root/.npm/_npx/dd48173ecf795e2b/node_modules/playwright/index.mjs';
const executablePath = process.env.CHROMIUM_PATH ?? '/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const { chromium } = await import(pathToFileURL(sdk).href);
const temporary = await mkdtemp(resolve(tmpdir(), 'slider-browser-'));
const outputFlag = process.argv.indexOf('--output');
const output = outputFlag < 0 ? resolve(temporary, 'result.json') : resolve(process.argv[outputFlag + 1]);
const report = {
  schema: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  browser: {},
  provenance: {},
  processes: {},
  cases: [],
  blockers: [],
  limitations: [
    'Linux headless Chromium with real production React Slider and CSS; not Windows WebView2 or Android hardware.',
    'CDP mouse/keyboard/wheel/touch produce browser isTrusted=true events; they are automated, not physical human gestures.',
    'Native range injection probes use dispatchEvent and are explicitly untrusted; SpeedEdit invokes the real claimed target API.',
    'The isolated component does not mount application-wide editor shortcuts or exercise non-adjustment caller panels.',
    'Each motion waits two animation frames so all emitted values are checked without relying on timing/coalescing to hide leaks.',
  ],
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourcePath = 'src/components/ui/Slider.tsx';
const sourceBefore = await readFile(resolve(repository, sourcePath));
const oldSource = process.env.SLIDER_OLD_SOURCE
  ? await readFile(process.env.SLIDER_OLD_SOURCE)
  : execFileSync('git', ['show', `72dc3ec9:${sourcePath}`], { cwd: repository });
report.provenance = {
  productionSliderSha256: sha(sourceBefore),
  oldSliderSha256: sha(oldSource),
  oldSource: process.env.SLIDER_OLD_SOURCE ?? `git 72dc3ec9:${sourcePath}`,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  files: {},
};
for (const file of [
  'checks/slider/run.mjs',
  'checks/slider/fixture.tsx',
  'checks/slider/vite.config.mjs',
  'checks/slider/actualstyles.css',
  'checks/slider/index.html',
  'checks/slider/virtual.d.ts',
  'src/styles.css',
  'src/components/ui/AppProperties.tsx',
  'src/store/useEditorStore.ts',
  'src/store/useSettingsStore.ts',
]) {
  report.provenance.files[file] = sha(await readFile(resolve(repository, file)));
}

let viteLog = '';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'checks/slider/vite.config.mjs'], {
  cwd: repository,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
report.processes.vitePid = vite.pid;
vite.stdout.on('data', (chunk) => (viteLog += chunk));
vite.stderr.on('data', (chunk) => (viteLog += chunk));
let browser;
let activePage;
let activeCaseName;
const errors = [];

const base = { width: 200, min: -100, max: 100, step: 0.1, value: 0, platform: 'windows' };
const variants = [base, { ...base, width: 400, min: -1000, max: 1000 }];
const frames = (page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const mark = (page, phase) => page.evaluate((next) => window.sliderFixture.mark(next), phase);
const observations = (page) => page.evaluate(() => window.sliderFixture.read());
const values = (trace, phase) =>
  trace
    .filter((item) => item.kind === 'output' && (phase === undefined || item.phase === phase))
    .map((item) => item.value);
const closeTo = (actual, expected, context) =>
  assert.ok(
    expected === 0 ? actual === 0 : Math.abs(actual - expected) < 1e-7,
    `${context}: expected ${expected}, got ${actual}`,
  );
const allValues = (trace, phase, expected, required = true) => {
  const emitted = values(trace, phase);
  if (required) assert.ok(emitted.length, `${phase}: no output`);
  for (const value of emitted) closeTo(value, expected, `${phase} complete output sequence ${JSON.stringify(emitted)}`);
};
const trusted = (trace, type) => {
  const events = trace.filter((item) => item.kind === 'native' && item.type === type);
  assert.ok(events.length, `No browser ${type} event recorded`);
  assert.ok(
    events.every((item) => item.trusted),
    `${type} must be browser-trusted`,
  );
};

async function setup(page, specification = base) {
  await page.evaluate((configuration) => window.sliderFixture.configure(configuration), specification);
  await frames(page);
  const range = page.locator('input[type="range"]');
  const bounds = await range.boundingBox();
  assert.ok(bounds);
  closeTo(bounds.width, specification.width, 'actual range width');
  const minPosition = specification.nonlinear ? Math.sqrt(specification.min + 100) : specification.min;
  const maxPosition = specification.nonlinear ? Math.sqrt(specification.max + 100) : specification.max;
  const zeroPosition = specification.nonlinear ? 10 : 0;
  const x = bounds.x + ((zeroPosition - minPosition) / (maxPosition - minPosition)) * bounds.width;
  return { range, x, y: bounds.y + bounds.height / 2, bounds, minPosition, maxPosition };
}

function rawValue(specification, offset) {
  const span = specification.nonlinear
    ? Math.sqrt(specification.max + 100) - Math.sqrt(specification.min + 100)
    : specification.max - specification.min;
  const position = (specification.nonlinear ? 10 : 0) + (offset / specification.width) * span;
  const value = specification.nonlinear ? position ** 2 - 100 : position;
  return Math.round((value - specification.min) / specification.step) * specification.step + specification.min;
}

async function valueNow(page) {
  return Number(await page.locator('#value').textContent());
}

async function runCase(page, name, action, expectation = 'pass') {
  activePage = page;
  activeCaseName = name;
  await page.evaluate(() => window.sliderFixture.clear());
  const entry = { name, expectation };
  report.cases.push(entry);
  let error;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  entry.trace = await observations(page);
  if (error) {
    await page.mouse.up();
    for (const key of ['Shift', 'Alt', 'Control', 'Meta']) await page.keyboard.up(key);
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch((cleanupError) => {
      if (!String(cleanupError).includes('Must send a TouchStart first')) throw cleanupError;
    });
    await session.detach();
  }
  if (expectation === 'old-must-fail') {
    assert.ok(error, `${name}: negative control unexpectedly passed`);
    assert.match(String(error), /expected 0, got/, 'Negative control must fail specifically on missing zero snapping');
    entry.status = 'expected-failure';
    entry.reason = String(error);
  } else {
    entry.status = error ? 'failed' : 'passed';
    if (error) {
      entry.reason = String(error);
    }
  }
  console.log(`${entry.status}: ${name}`);
  return entry;
}

async function trackClicks(page, specification, snaps = true) {
  for (const offset of [-6, -4, -1, 0, 1, 4, 6, -5, 5]) {
    const { x, y } = await setup(page, { ...specification, value: rawValue(specification, -24) });
    const phase = `click:${offset}px`;
    await mark(page, phase);
    await page.mouse.click(x + offset, y);
    await frames(page);
    const expected = snaps && Math.abs(offset) <= 5 ? 0 : rawValue(specification, offset);
    const trace = await observations(page);
    allValues(trace, phase, expected);
    closeTo(await valueNow(page), expected, phase);
    trusted(trace, 'mousedown');
  }
  return values(await observations(page));
}

async function mousePath(page, specification, snaps = true, modifier) {
  const { x, y } = await setup(page, { ...specification, value: rawValue(specification, -24) });
  await mark(page, 'start:-24px');
  await page.mouse.move(x - 24, y);
  await page.mouse.down();
  await frames(page);
  allValues(await observations(page), 'start:-24px', rawValue(specification, -24));
  if (modifier) await page.keyboard.down(modifier);
  // Fine adjustment is 0.2; these physical displacements still traverse the same logical positions.
  const factor = modifier ? 5 : 1;
  const offsets = [-12, -6, -5, -4, -1, 0, 1, 4, 5, 6, 12, 6, 4, 1, 0, -1, -4, -5, -6, -12];
  for (const offset of offsets) {
    const phase = `move:${offset}px:${offsets.indexOf(offset)}`;
    // Use a unique phase even when revisiting the same position in the opposite direction.
    const uniquePhase = `${phase}:${(await observations(page)).length}`;
    await mark(page, uniquePhase);
    await page.mouse.move(x - 24 + (offset + 24) * factor, y);
    await frames(page);
    const expected = snaps && !modifier && Math.abs(offset) <= 5 ? 0 : rawValue(specification, offset);
    allValues(await observations(page), uniquePhase, expected, false);
    closeTo(await valueNow(page), expected, uniquePhase);
  }
  if (modifier) await page.keyboard.up(modifier);
  await mark(page, 'mouseup');
  await page.mouse.up();
  await frames(page);
  allValues(await observations(page), 'mouseup', rawValue(specification, -12), false);
  const trace = await observations(page);
  trusted(trace, 'mousedown');
  trusted(trace, 'mousemove');
  trusted(trace, 'mouseup');
  return values(trace);
}

async function touchPath(page, specification, snaps = true, modifier) {
  const { x, y } = await setup(page, { ...specification, value: rawValue(specification, -24) });
  const session = await page.context().newCDPSession(page);
  const send = (type, offset) =>
    session.send('Input.dispatchTouchEvent', {
      type,
      modifiers: modifier === 'Shift' ? 8 : modifier === 'Alt' ? 1 : 0,
      touchPoints:
        type === 'touchEnd'
          ? []
          : [{ x: modifier ? x - 24 + (offset + 24) * 5 : x + offset, y, id: 1, radiusX: 1, radiusY: 1 }],
    });
  try {
    await mark(page, 'touchstart');
    await send('touchStart', -24);
    await frames(page);
    await mark(page, 'below-threshold');
    await send('touchMove', modifier ? -23.2 : -20);
    await frames(page);
    assert.deepEqual(values(await observations(page)), [], 'Touch must not output before 10px activation');
    // Chromium withholds touchmove until its own slop is crossed; activate with 20px (> app's 10px).
    for (const [index, offset] of [
      -4, -6, -12, -6, -5, -4, -1, 0, 1, 4, 5, 6, 12, 6, 4, 1, 0, -1, -4, -6, -12, -4,
    ].entries()) {
      const phase = `touchmove:${index}:${offset}px`;
      await mark(page, phase);
      await send('touchMove', offset);
      await frames(page);
      const expected = snaps && !modifier && Math.abs(offset) <= 5 ? 0 : rawValue(specification, offset);
      allValues(await observations(page), phase, expected, false);
      closeTo(await valueNow(page), expected, phase);
    }
    await mark(page, 'touchend');
    await send('touchEnd');
    await frames(page);
    await page.waitForTimeout(180);
    const expected = snaps && !modifier ? 0 : rawValue(specification, -4);
    allValues(await observations(page), 'touchend', expected, false);
    closeTo(await valueNow(page), expected, 'touchend and delayed native defaults');
    const trace = await observations(page);
    trusted(trace, 'touchstart');
    trusted(trace, 'touchmove');
    trusted(trace, 'touchend');
    assert.ok(
      trace.some((item) => item.kind === 'drag' && item.dragging === true),
      'Touch drag must activate',
    );
    assert.ok(
      trace.some((item) => item.kind === 'drag' && item.dragging === false),
      'Touch drag must end',
    );
    return values(trace);
  } finally {
    await session.detach();
  }
}

async function nativeProbe(page, touch = false) {
  const { x, y } = await setup(page, { ...base, value: -24 });
  let session;
  if (touch) {
    session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 24, y }] });
    await frames(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 4, y }] });
  } else {
    await page.mouse.move(x - 4, y);
    await page.mouse.down();
  }
  await frames(page);
  closeTo(await valueNow(page), 0, 'precondition: drag is snapped');
  await mark(page, 'untrusted-native-probe');
  await page.evaluate(() => {
    const range = document.querySelector('input[type="range"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, '42');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await frames(page);
  assert.deepEqual(
    values(await observations(page), 'untrusted-native-probe'),
    [],
    'Native range cannot bypass active drag',
  );
  await mark(page, 'release-after-probe');
  if (session) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  } else await page.mouse.up();
  await frames(page);
  allValues(await observations(page), 'release-after-probe', 0, false);
  closeTo(await valueNow(page), 0, 'probe must not leak to controlled value');
  const probeEvents = (await observations(page)).filter(
    (item) => item.kind === 'native' && item.phase === 'untrusted-native-probe',
  );
  assert.deepEqual(
    probeEvents.map((item) => [item.type, item.trusted]),
    [
      ['input', false],
      ['change', false],
    ],
  );
}

async function textAndArrows(page, specification = base) {
  await setup(page, { ...specification, step: 1 });
  await page.locator('[data-tooltip="Click to edit"]').click();
  const input = page.locator('input[type="text"]');
  for (const value of [-1, 1]) {
    const phase = `typed:${value}`;
    await mark(page, phase);
    await input.fill('');
    await input.pressSequentially(String(value));
    await frames(page);
    allValues(await observations(page), phase, value);
    closeTo(await valueNow(page), value, phase);
  }
  await input.fill('0');
  for (const [key, expected] of [
    ['ArrowUp', 1],
    ['ArrowDown', 0],
    ['ArrowDown', -1],
  ]) {
    const phase = `text-key:${key}:${expected}`;
    await mark(page, phase);
    await input.press(key);
    await frames(page);
    allValues(await observations(page), phase, expected);
  }
  await input.press('Enter');
  const trace = await observations(page);
  trusted(trace, 'keydown');
  trusted(trace, 'input');
}

async function rangeArrows(page, implementation, platform = 'windows') {
  const result = [];
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    const { range } = await setup(page, { ...base, step: 1, platform });
    await range.focus();
    await mark(page, key);
    await page.keyboard.press(key);
    await frames(page);
    const trace = (await observations(page)).filter((item) => item.phase === key);
    const emitted = values(trace);
    const focused = await range.evaluate((element) => element === document.activeElement);
    const globalShortcutCount = trace.filter((item) => item.kind === 'globalShortcut').length;
    trusted(trace, 'keydown');
    result.push({ key, emitted, focused, globalShortcutCount, finalValue: await valueNow(page), trace });
    const expected = key === 'ArrowUp' || key === 'ArrowRight' ? 1 : -1;
    if (implementation === 'after' && platform !== 'android') {
      allValues(trace, key, expected);
      closeTo(await valueNow(page), expected, `focused range ${key}`);
      assert.equal(focused, true, `${key}: desktop range must retain focus`);
      assert.equal(globalShortcutCount, 0, `${key}: desktop range must stop global shortcut propagation`);
    } else {
      allValues(trace, key, expected);
      assert.equal(focused, false, `${implementation}/${platform}: baseline arrow blurs range`);
      assert.equal(globalShortcutCount, 1, `${implementation}/${platform}: baseline arrow bubbles globally`);
    }
  }
  return result;
}

async function globalKeyBoundaries(page, platform = 'windows') {
  const result = [];
  for (const key of ['Control+ArrowUp', 'Meta+ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    const { range } = await setup(page, { ...base, step: 1, platform });
    if (key.includes('+')) await range.focus();
    else await page.mouse.click(600, 300);
    const phase = `boundary:${key}`;
    await mark(page, phase);
    await page.keyboard.press(key);
    await frames(page);
    const trace = (await observations(page)).filter((item) => item.phase === phase);
    const emitted = values(trace);
    const focused = await range.evaluate((element) => element === document.activeElement);
    const globalShortcutCount = trace.filter((item) => item.kind === 'globalShortcut').length;
    assert.deepEqual(emitted, [], `${key}: global/unfocused path must not change Slider`);
    assert.equal(focused, false, `${key}: preserve Ctrl/Meta blur or outside focus`);
    assert.equal(globalShortcutCount, 1, `${key}: preserve global propagation`);
    trusted(trace, 'keydown');
    result.push({ key, emitted, focused, globalShortcutCount });
  }
  return result;
}

async function wheel(page, specification = base) {
  const { x, y } = await setup(page, { ...specification, step: 1 });
  await page.mouse.move(x, y);
  await page.keyboard.down('Shift');
  try {
    for (const [delta, expected] of [
      [-40, 1],
      [40, 0],
      [40, -1],
    ]) {
      const phase = `wheel:${expected}`;
      await mark(page, phase);
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(60);
      await frames(page);
      allValues(await observations(page), phase, expected);
      closeTo(await valueNow(page), expected, phase);
    }
    trusted(await observations(page), 'wheel');
  } finally {
    await page.keyboard.up('Shift');
  }
}

async function speedEdit(page, specification = base) {
  const { x, y } = await setup(page, { ...specification, step: 1 });
  await page.mouse.click(x, y);
  await frames(page);
  for (const value of [-1, 1]) {
    const phase = `SpeedEdit-api:${value}`;
    await mark(page, phase);
    await page.evaluate((position) => window.sliderFixture.speedEdit(position), value);
    await frames(page);
    allValues(await observations(page), phase, value);
  }
}

async function optOut(page, specification) {
  for (const offset of [-4, 4]) {
    const { x, y } = await setup(page, specification);
    await mark(page, `opt-out:${offset}`);
    await page.mouse.click(x + offset, y);
    await frames(page);
    allValues(await observations(page), `opt-out:${offset}`, rawValue(specification, offset));
  }
}

async function resets(page, defaultValue, specification = base) {
  for (const method of ['label', 'double-click']) {
    const { x, y } = await setup(page, { ...specification, defaultValue, value: 40 });
    const phase = `reset:${defaultValue}:${method}`;
    await mark(page, phase);
    if (method === 'label') await page.locator('#fixture .grid').click();
    else await page.mouse.dblclick(x + 32, y, { delay: 40 });
    await frames(page);
    closeTo(await valueNow(page), defaultValue, `${method} reset`);
    const emitted = values(await observations(page), phase);
    assert.ok(emitted.length);
    closeTo(emitted.at(-1), defaultValue, `${method} last reset output`);
    // Double click has an initial track mousedown output before the reset event; preserve it in evidence.
    if (method === 'label') allValues(await observations(page), phase, defaultValue);
    else trusted(await observations(page), 'dblclick');
  }
}

async function androidPrecisionAndResets(page) {
  const android = { ...base, platform: 'android' };
  await textAndArrows(page, android);
  await wheel(page, android);
  await speedEdit(page, android);
  await resets(page, 0, android);
  await resets(page, 25, android);
  return values(await observations(page));
}

try {
  const deadline = Date.now() + 30000;
  while (true) {
    if (vite.exitCode !== null) throw new Error(`Own Vite exited: ${viteLog}`);
    if (viteLog.includes('Local:')) break;
    if (Date.now() > deadline) throw new Error(`Own Vite failed to start: ${viteLog}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  report.browser = { version: browser.version(), executablePath, sdk };
  const browserSession = await browser.newBrowserCDPSession();
  const processInfo = await browserSession.send('SystemInfo.getProcessInfo');
  report.processes.browserPid = processInfo.processInfo.find((item) => item.type === 'browser')?.id;
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true });
  context.on('page', (page) => {
    const recordError = (message) =>
      errors.push({ message, implementation: page.url().includes('?old') ? 'before' : 'after', case: activeCaseName });
    page.on('pageerror', (error) => recordError(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') recordError(message.text());
    });
  });
  const oldPage = await context.newPage();
  await oldPage.goto('http://127.0.0.1:9142/checks/slider/index.html?old');
  await oldPage.waitForFunction(() => window.sliderFixture);
  // Negative controls run first against the exact old component, before any after claim.
  await runCase(oldPage, 'before: track snap negative control', () => trackClicks(oldPage, base), 'old-must-fail');
  await runCase(oldPage, 'before: mouse snap negative control', () => mousePath(oldPage, base), 'old-must-fail');
  await runCase(oldPage, 'before: touch snap negative control', () => touchPath(oldPage, base), 'old-must-fail');
  // A negative-control drag can stop at its failing waypoint; release before independent cases.
  await oldPage.mouse.up();
  const releaseTouch = await context.newCDPSession(oldPage);
  await releaseTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch((error) => {
    if (!String(error).includes('Must send a TouchStart first')) throw error;
  });
  await releaseTouch.detach();
  let beforeArrows;
  await runCase(oldPage, 'before: native range arrow blur/global propagation baseline', async () => {
    beforeArrows = await rangeArrows(oldPage, 'before');
  });
  await runCase(oldPage, 'before: Ctrl/Meta and unfocused global boundaries', () => globalKeyBoundaries(oldPage));
  let oldAndroidArrows;
  let oldAndroidBoundaries;
  await runCase(oldPage, 'before: Android arrow/global baseline', async () => {
    oldAndroidArrows = await rangeArrows(oldPage, 'before', 'android');
    oldAndroidBoundaries = await globalKeyBoundaries(oldPage, 'android');
  });
  const oldAndroid = {};
  await runCase(oldPage, 'before: Android precision and resets', async () => {
    oldAndroid.precision = await androidPrecisionAndResets(oldPage);
  });
  for (const [index, specification] of variants.entries()) {
    const android = { ...specification, platform: 'android' };
    await runCase(oldPage, `before: Android track ${index}`, async () => {
      oldAndroid[`track${index}`] = await trackClicks(oldPage, android, false);
    });
    await runCase(oldPage, `before: Android mouse ${index}`, async () => {
      oldAndroid[`mouse${index}`] = await mousePath(oldPage, android, false);
    });
    await runCase(oldPage, `before: Android touch ${index}`, async () => {
      oldAndroid[`touch${index}`] = await touchPath(oldPage, android, false);
    });
  }
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:9142/checks/slider/index.html');
  await page.waitForFunction(() => window.sliderFixture);
  await runCase(page, 'after: Android precision and resets exact before outputs', async () => {
    assert.deepEqual(await androidPrecisionAndResets(page), oldAndroid.precision);
  });
  for (const [index, specification] of variants.entries()) {
    await runCase(page, `after: track +/-5px width/range ${index}`, () => trackClicks(page, specification));
    await runCase(page, `after: continuous mouse both directions ${index}`, () => mousePath(page, specification));
    await runCase(page, `after: touch threshold, both directions, end ${index}`, () => touchPath(page, specification));
  }
  for (const modifier of ['Shift', 'Alt']) {
    await runCase(page, `after: ${modifier} fine mouse bypass`, () => mousePath(page, base, false, modifier));
    await runCase(page, `after: ${modifier} track bypass`, async () => {
      await page.keyboard.down(modifier);
      try {
        await optOut(page, base);
      } finally {
        await page.keyboard.up(modifier);
      }
    });
    await runCase(page, `after: ${modifier} trusted touch bypass`, () => touchPath(page, base, false, modifier));
  }
  await runCase(page, 'after: mouse active native range untrusted probe', () => nativeProbe(page));
  await runCase(page, 'after: touch active native range untrusted probe', () => nativeProbe(page, true));
  await runCase(page, 'after: trusted text +/-1 and text Up/Down', () => textAndArrows(page));
  await runCase(page, 'after: four native range arrows +/-1, retain focus, stop global propagation', async () => {
    const afterArrows = await rangeArrows(page, 'after');
    report.rangeArrows = { before: beforeArrows, after: afterArrows };
  });
  await runCase(page, 'after: macOS four focused range arrows +/-1', () => rangeArrows(page, 'after', 'macos'));
  await runCase(page, 'after: Ctrl/Meta and unfocused global boundaries', () => globalKeyBoundaries(page));
  await runCase(page, 'after: Android arrows/global boundaries exact before behavior', async () => {
    const after = await rangeArrows(page, 'after', 'android');
    const stripTrace = (entries) => entries.map(({ trace: _trace, ...entry }) => entry);
    assert.deepEqual(stripTrace(after), stripTrace(oldAndroidArrows));
    assert.deepEqual(await globalKeyBoundaries(page, 'android'), oldAndroidBoundaries);
  });
  await runCase(page, 'after: trusted Shift wheel +/-1', () => wheel(page));
  await runCase(page, 'after: real editor store SpeedEdit target +/-1 API', () => speedEdit(page));
  const nonlinear = { ...base, width: 360, max: 800, nonlinear: true };
  await runCase(page, 'after: nonlinear zero at 1/3 track clicks', () => trackClicks(page, nonlinear));
  await runCase(page, 'after: nonlinear continuous mouse', () => mousePath(page, nonlinear));
  await runCase(page, 'after: nonlinear touch', () => touchPath(page, nonlinear));
  await runCase(page, 'after: nonzero default bypass', () => optOut(page, { ...base, defaultValue: 50 }));
  await runCase(page, 'after: explicit snapToZero=false bypass', () => optOut(page, { ...base, snapToZero: false }));
  await runCase(page, 'after: range excludes zero even with explicit true', async () => {
    const specification = { ...base, min: 10, max: 110, value: 20, snapToZero: true };
    const { bounds, y } = await setup(page, specification);
    await mark(page, 'positive-range');
    await page.mouse.click(bounds.x + 4, y);
    await frames(page);
    allValues(await observations(page), 'positive-range', 12);
  });
  for (const defaultValue of [0, 25]) {
    await runCase(page, `after: label/double-click reset to ${defaultValue}`, () => resets(page, defaultValue));
  }
  for (const [index, specification] of variants.entries()) {
    const android = { ...specification, platform: 'android' };
    await runCase(page, `after: Android track ${index} exact before outputs`, async () => {
      assert.deepEqual(await trackClicks(page, android, false), oldAndroid[`track${index}`]);
    });
    await runCase(page, `after: Android mouse ${index} exact before outputs`, async () => {
      assert.deepEqual(await mousePath(page, android, false), oldAndroid[`mouse${index}`]);
    });
    await runCase(page, `after: Android touch ${index} exact before outputs`, async () => {
      assert.deepEqual(await touchPath(page, android, false), oldAndroid[`touch${index}`]);
    });
  }
  assert.deepEqual(
    report.cases
      .filter((entry) => entry.status === 'failed')
      .map((entry) => ({ name: entry.name, reason: entry.reason })),
    [],
    'All independent browser cases must pass',
  );
  const passiveWarning = 'Unable to preventDefault inside passive event listener invocation.';
  const baselinePassive = errors.filter(
    (entry) => entry.implementation === 'before' && entry.message === passiveWarning,
  );
  const unexpectedErrors = errors.filter((entry) => entry.message !== passiveWarning || !baselinePassive.length);
  assert.deepEqual(unexpectedErrors, [], 'Unexpected browser console/page errors');
  const warningCounts = Object.fromEntries(
    [...new Set(errors.map((entry) => entry.case))].map((name) => [
      name,
      errors.filter((entry) => entry.case === name).length,
    ]),
  );
  const baselineMaximum = Math.max(0, ...baselinePassive.map((entry) => warningCounts[entry.case]));
  for (const entry of errors.filter((item) => item.implementation === 'after')) {
    assert.ok(
      warningCounts[entry.case] <= baselineMaximum,
      'No increase over baseline passive touch warning per gesture',
    );
  }
  report.baselineConsoleDiagnostic = {
    message: passiveWarning,
    baselineMaximumPerCase: baselineMaximum,
    warningCounts,
  };
  assert.equal(
    sha(await readFile(resolve(repository, sourcePath))),
    sha(sourceBefore),
    'Production Slider changed during run',
  );
  report.status = report.blockers.length ? 'passed-with-pre-existing-requirement-conflict' : 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack ?? error);
  if (activePage) report.failureTrace = await observations(activePage).catch(() => []);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
  if (vite.exitCode === null && vite.signalCode === null) {
    await new Promise((done) => {
      vite.once('exit', done);
      setTimeout(done, 3000).unref();
    });
  }
  report.processes.stopped = {
    browser: !browser?.isConnected(),
    vite: vite.exitCode !== null || vite.signalCode !== null,
  };
  report.finishedAt = new Date().toISOString();
  report.browserErrors = errors;
  await writeFile(resolve(temporary, 'vite.log'), viteLog);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${output}\nStatus: ${report.status}\nProcesses: ${JSON.stringify(report.processes)}`);
}
