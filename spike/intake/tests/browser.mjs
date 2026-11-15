// Production HTML/JS, Linux Chromium and a deliberately mocked Tauri host.
// This validates renderer behavior, not AppKit/WKWebView or real file paths.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const files = new Map([
  ['/', ['../web/index.html', 'text/html']],
  ['/probe.js', ['../web/probe.js', 'text/javascript']],
  ['/drop-resolution.mjs', ['../web/drop-resolution.mjs', 'text/javascript']],
  ['/style.css', ['../web/style.css', 'text/css']],
  ['/original.png', ['../src-tauri/tests/fixtures/rgba.png', 'image/png']],
]);
let originalRequests = 0;
const errors = [];
const results = [];
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const entry = files.get(pathname);
  if (!entry) {
    response.writeHead(404).end();
    return;
  }
  try {
    if (pathname === '/original.png') originalRequests += 1;
    const body = await readFile(new URL(entry[0], import.meta.url));
    response.writeHead(200, { 'content-type': entry[1] }).end(body);
  } catch (error) {
    errors.push(String(error));
    response.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.INTAKE_CHROMIUM || undefined,
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    const hostCrypto = crypto.subtle;
    const state = (window.intakeHost = {
      calls: [],
      report: null,
      exports: 0,
      fileReads: 0,
      nativePaths: [],
      captureStatus: 'paired',
      domDrops: 0,
    });
    document.addEventListener(
      'drop',
      () => {
        state.domDrops += 1;
      },
      true,
    );
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function (...args) {
      state.fileReads += 1;
      return read.apply(this, args);
    };
    window.__TAURI__ = {
      core: {
        async invoke(command, args = {}) {
          state.calls.push({ command, args });
          switch (command) {
            case 'environment':
              return { os: 'macos', nativeDragDrop: false };
            case 'install_macos_drag_bridge':
              return { installed: true, mocked: true };
            case 'arm_macos_drop_capture':
              return { captureId: args.captureId, status: 'armed' };
            case 'finish_macos_drop_capture':
              return {
                status: state.captureStatus,
                paths: state.nativePaths,
                captureId: args.captureId,
                htmlDropId: args.htmlDropId,
              };
            case 'hash_web_drop_bytes': {
              if (!(args instanceof Uint8Array)) throw Error('Expected binary web bytes');
              const digest = await hostCrypto.digest('SHA-256', args);
              return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
            }
            case 'save_report':
              state.report = structuredClone(args.report);
              state.exports += 1;
              return '/mock/report.json';
            case 'read_system_clipboard':
              return { kind: 'busy', reason: 'mocked-deadline', selected: null };
            case 'read_original_image_url': {
              const response = await fetch(args.url);
              const bytes = await response.arrayBuffer();
              const digest = await hostCrypto.digest('SHA-256', bytes);
              const url = new URL(args.url);
              url.search = '';
              url.hash = '';
              return {
                acquisition: 'explicit-url-request',
                originalDropByteIdentity: 'unverified',
                format: 'png',
                sha256: Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join(''),
                encodedBytes: bytes.byteLength,
                requestedUrl: url.href,
                mocked: true,
              };
            }
            default:
              throw Error(`Unexpected mocked command: ${command}`);
          }
        },
      },
      event: {
        async listen() {
          return () => {};
        },
      },
      webview: {
        getCurrentWebview() {
          return { async onDragDropEvent() {} };
        },
      },
    };
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => !document.querySelector('#mac-capture').disabled);
  const session = await page.context().newCDPSession(page);
  const fixture = fileURLToPath(new URL('../src-tauri/tests/fixtures/rgba.png', import.meta.url));
  const records = async () => {
    const before = await page.evaluate(() => intakeHost.exports);
    await page.click('#export');
    await page.waitForFunction((previous) => intakeHost.exports > previous, before);
    return page.evaluate(() => intakeHost.report.records);
  };
  const drop = async (items = []) => {
    const previousDrops = await page.evaluate(() => intakeHost.domDrops);
    await page.locator('#drop').scrollIntoViewIfNeeded();
    const box = await page.locator('#drop').boundingBox();
    const position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await session.send('Input.dispatchDragEvent', {
        type,
        ...position,
        data: { items, files: [fixture], dragOperationsMask: 1 },
      });
    }
    await page.waitForFunction((previous) => intakeHost.domDrops > previous, previousDrops);
  };
  const waitResolution = async () => {
    const id = await page.evaluate(
      () =>
        JSON.parse(document.querySelector('#log').textContent)
          .filter((record) => record.type === 'html-drop')
          .at(-1).htmlDropId,
    );
    await page.waitForFunction((dropId) => {
      const value = document.querySelector('#log').textContent;
      return JSON.parse(value).some((record) => record.type === 'drop-resolution' && record.htmlDropId === dropId);
    }, id);
  };

  await page.evaluate(() => {
    intakeHost.nativePaths = ['/照片/真实 RAW.NEF', '/照片/folder'];
  });
  await page.click('#mac-capture');
  await drop();
  await waitResolution(0);
  let captured = await records();
  assert.equal(captured.find((record) => record.type === 'html-drop').data.trustedInput, true);
  assert.deepEqual(captured.find((record) => record.type === 'drop-resolution').data.paths, [
    '/照片/真实 RAW.NEF',
    '/照片/folder',
  ]);
  assert.equal(await page.evaluate(() => intakeHost.fileReads), 0);
  results.push('paired-native-paths-skip-file-bytes');

  await drop();
  await waitResolution(1);
  captured = await records();
  assert.equal(captured.filter((record) => record.type === 'drop-resolution').at(-1).data.kind, 'unresolved');
  assert.equal(await page.evaluate(() => intakeHost.fileReads), 0);
  results.push('next-drop-does-not-reuse-native-paths');

  await page.click('#mac-capture');
  const finishesBefore = await page.evaluate(
    () => intakeHost.calls.filter((call) => call.command === 'finish_macos_drop_capture').length,
  );
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['fake'], 'fake.nef', { type: 'image/x-nikon-nef' }));
    document.querySelector('#drop').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
  });
  await waitResolution(2);
  assert.equal(
    await page.evaluate(() => intakeHost.calls.filter((call) => call.command === 'finish_macos_drop_capture').length),
    finishesBefore,
  );
  await drop();
  await waitResolution(3);
  assert.equal(
    await page.evaluate(() => intakeHost.calls.filter((call) => call.command === 'finish_macos_drop_capture').length),
    finishesBefore + 1,
  );
  results.push('synthetic-drop-cannot-consume-prepared-capture');

  await page.evaluate(() => {
    intakeHost.captureStatus = 'ambiguous';
  });
  await page.click('#mac-capture');
  await drop();
  await waitResolution(4);
  captured = await records();
  assert.equal(captured.filter((record) => record.type === 'drop-resolution').at(-1).data.kind, 'unresolved');
  assert.equal(await page.evaluate(() => intakeHost.fileReads), 0);
  results.push('ambiguous-capture-does-not-authorize-paths');

  const source = `${origin}/original.png?token=not-for-the-report`;
  await drop([
    { mimeType: 'text/uri-list', data: source },
    { mimeType: 'text/html', data: `<img src="${source}">` },
  ]);
  await page.waitForFunction(() =>
    JSON.parse(document.querySelector('#log').textContent).some((record) => record.type === 'html-file-bytes'),
  );
  captured = await records();
  const expectedHash = createHash('sha256')
    .update(await readFile(fixture))
    .digest('hex');
  assert.equal(captured.find((record) => record.type === 'html-file-bytes').data.sha256, expectedHash);
  assert.equal(originalRequests, 0, 'Parsing HTML must not load the source image');
  await page.click('#original-image');
  await page.waitForFunction(() =>
    JSON.parse(document.querySelector('#log').textContent).some((record) => record.type === 'original-image-response'),
  );
  captured = await records();
  const response = captured.find((record) => record.type === 'original-image-response').data;
  assert.equal(response.sha256, expectedHash);
  assert.equal(response.identicalToReceivedFile, true);
  assert.equal(response.originalDropByteIdentity, 'unverified');
  assert.equal(originalRequests, 1);
  results.push('inert-source-parsing-and-explicit-original-url-read');

  await page.evaluate(() => {
    intakeHost.captureStatus = 'paired';
    intakeHost.nativePaths = [];
  });
  for (const src of ['blob:https://example.test/image', 'data:image/png;base64,AAAA', '/relative.png']) {
    const previousReads = await page.evaluate(() => intakeHost.fileReads);
    await drop([{ mimeType: 'text/html', data: `<img src="${src}">` }]);
    await waitResolution();
    await page.waitForFunction((previous) => intakeHost.fileReads > previous, previousReads);
    captured = await records();
    const latestDrop = captured.filter((record) => record.type === 'html-drop').at(-1).htmlDropId;
    await page.waitForFunction(
      (id) =>
        JSON.parse(document.querySelector('#log').textContent).some(
          (record) => record.type === 'html-image-decoded' && record.htmlDropId === id,
        ),
      latestDrop,
    );
    assert.equal(captured.filter((record) => record.type === 'drop-resolution').at(-1).data.kind, 'web');
    assert.equal(await page.locator('#original-image').isDisabled(), true);
  }
  results.push('blob-data-relative-files-remain-readable-without-url-fetch');

  const pendingStart = await page.evaluate(
    () => intakeHost.calls.filter((call) => call.command === 'read_original_image_url').length,
  );
  await page.evaluate(
    async ({ fixtureBytes, sourceUrl }) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const first = new File([blob], 'different.png', { type: 'image/png' });
      const second = new File([new Uint8Array(fixtureBytes)], 'matching.png', { type: 'image/png' });
      const read = second.arrayBuffer.bind(second);
      second.arrayBuffer = async () => {
        await new Promise((resolve) => {
          window.releaseSecondFile = resolve;
        });
        return read();
      };
      const transfer = new DataTransfer();
      transfer.items.add(first);
      transfer.items.add(second);
      transfer.setData('text/html', `<img src="${sourceUrl}">`);
      document.querySelector('#drop').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
    },
    { fixtureBytes: Array.from(await readFile(fixture)), sourceUrl: source },
  );
  await page.waitForFunction(() => typeof window.releaseSecondFile === 'function');
  assert.equal(await page.locator('#original-image').isDisabled(), true);
  await page.evaluate(() => document.querySelector('#original-image').click());
  assert.equal(
    await page.evaluate(() => intakeHost.calls.filter((call) => call.command === 'read_original_image_url').length),
    pendingStart,
  );
  await page.evaluate(() => window.releaseSecondFile());
  await page.waitForFunction(() => !document.querySelector('#original-image').disabled);
  await page.click('#original-image');
  await page.waitForFunction(
    (previous) => intakeHost.calls.filter((call) => call.command === 'read_original_image_url').length > previous,
    pendingStart,
  );
  await page.waitForFunction(() =>
    JSON.parse(document.querySelector('#log').textContent).some(
      (record) => record.type === 'original-image-response' && record.data.receivedRepresentations.length === 2,
    ),
  );
  captured = await records();
  const completeResponse = captured.filter((record) => record.type === 'original-image-response').at(-1).data;
  assert.equal(completeResponse.receivedRepresentationsComplete, true);
  assert.equal(completeResponse.identicalToReceivedFile, true);
  assert.equal(completeResponse.receivedRepresentations[1].sha256, expectedHash);
  await page.waitForTimeout(50);
  const reexported = await records();
  assert.deepEqual(
    reexported.filter((record) => record.type === 'original-image-response').at(-1).data,
    completeResponse,
  );
  results.push('url-comparison-waits-for-all-file-hashes-and-exports-an-immutable-snapshot');

  await page.evaluate(() => Object.defineProperty(crypto, 'subtle', { configurable: true, value: undefined }));
  await drop([{ mimeType: 'text/html', data: '<img src="blob:https://example.test/fallback">' }]);
  await waitResolution();
  await page.waitForFunction(() => intakeHost.calls.some((call) => call.command === 'hash_web_drop_bytes'));
  captured = await records();
  const fallbackId = captured.filter((record) => record.type === 'html-drop').at(-1).htmlDropId;
  await page.waitForFunction(
    (id) =>
      JSON.parse(document.querySelector('#log').textContent).some(
        (record) => record.type === 'html-file-bytes' && record.htmlDropId === id,
      ),
    fallbackId,
  );
  captured = await records();
  assert.equal(
    captured.filter((record) => record.type === 'html-file-bytes' && record.htmlDropId === fallbackId)[0].data.sha256,
    expectedHash,
  );
  results.push('custom-scheme-without-subtlecrypto-uses-binary-hash-command');

  await page.click('#clipboard');
  await page.waitForFunction(() =>
    JSON.parse(document.querySelector('#log').textContent).some(
      (record) => record.type === 'system-clipboard' && record.data.kind === 'busy',
    ),
  );
  assert.equal(await page.locator('#clipboard').isDisabled(), false);
  results.push('busy-result-is-retained-and-button-recovers');
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    cases: results,
    browser: browser.version(),
    errors,
    scope: 'Production renderer with mocked Tauri host on Linux; no Mac/WKWebView claim',
  };
  if (process.env.INTAKE_BROWSER_RESULT)
    await writeFile(process.env.INTAKE_BROWSER_RESULT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
