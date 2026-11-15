import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  displayedUrl,
  fingerprintWebFile,
  hasWebImageSource,
  imageSignature,
  imageUrl,
  inspectResolvedFiles,
  MAX_IMAGE_BYTES,
  originalImageCandidate,
  resolveDrop,
} from '../web/drop-resolution.mjs';

globalThis.crypto ??= webcrypto;

test('paired native paths win without reading any File, including large RAW files', async () => {
  const paths = ['/照片/真实 RAW.NEF', '/photos/folder'];
  const file = {
    size: Number.MAX_SAFE_INTEGER,
    arrayBuffer() {
      throw Error('must not read local bytes');
    },
  };
  const resolution = resolveDrop({ status: 'paired', paths }, { url: 'https://example.test/image.webp' });
  assert.deepEqual(resolution.paths, paths);
  assert.equal(resolution.kind, 'files');
  assert.deepEqual(await inspectResolvedFiles([file], resolution), []);
});

test('unmatched, stale, duplicate and ambiguous captures never authorize native paths', () => {
  for (const status of ['pending', 'ambiguous', 'unmatched', 'expired', 'consumed']) {
    const result = resolveDrop({ status, paths: ['/stale/photo.jpg'] }, null);
    assert.equal(result.kind, 'unresolved');
    assert.equal(result.paths, undefined);
  }
  assert.equal(resolveDrop({ status: 'paired', paths: [null] }, null).kind, 'unresolved');
});

test('image source selection is explicit and rejects ambiguous or non-HTTP URLs', () => {
  assert.deepEqual(originalImageCandidate({ uriList: '# comment\r\nhttps://a.test/a.webp\r\n' }), {
    url: 'https://a.test/a.webp',
    provenance: 'uri-list',
  });
  assert.equal(originalImageCandidate({ uriList: 'https://a.test/a\nhttps://b.test/b' }), null);
  assert.equal(originalImageCandidate({ imageSources: ['https://a.test/a', 'https://b.test/b'] }), null);
  assert.equal(originalImageCandidate({ uriList: 'file:///Users/me/photo.webp' }), null);
  assert.equal(imageUrl('https://user:password@example.test/photo.webp'), null);
  assert.equal(imageUrl('javascript:alert(1)'), null);
  assert.equal(imageUrl('data:image/png;base64,AAAA'), null);
  assert.equal(imageUrl('/relative-image.webp'), null);
  assert.equal(imageUrl('https://a.test/a.webp#part'), 'https://a.test/a.webp');
});

test('query tokens are used for acquisition but omitted from display metadata', () => {
  const source = 'https://a.test/image.webp?token=private#fragment';
  assert.equal(imageUrl(source), 'https://a.test/image.webp?token=private');
  assert.deepEqual(displayedUrl(source), { url: 'https://a.test/image.webp', queryOmitted: true });
});

test('received web image bytes do not require a fetchable unique URL', () => {
  for (const sources of [
    ['blob:https://a.test/received-image'],
    ['data:image/png;base64,AAAA'],
    ['/relative.png'],
    ['https://a.test/a.png', 'https://b.test/b.png'],
  ]) {
    assert.equal(hasWebImageSource(sources), true);
    assert.equal(resolveDrop({ status: 'paired', paths: [] }, null, hasWebImageSource(sources)).kind, 'web');
  }
  for (const sources of [[], ['file:///photos/RAW.NEF'], ['javascript:alert(1)'], ['']]) {
    assert.equal(hasWebImageSource(sources), false);
    assert.equal(resolveDrop({ status: 'paired', paths: [] }, null, hasWebImageSource(sources)).kind, 'unresolved');
  }
  assert.equal(resolveDrop({ status: 'paired', paths: ['/photos/RAW.NEF'] }, null, true).kind, 'files');
});

test('actual signature wins over a WebP filename or MIME label', () => {
  assert.equal(imageSignature(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
  assert.equal(imageSignature(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])), 'webp');
  assert.equal(imageSignature(new Uint8Array([82, 73, 70, 70])), null);
});

test('web fingerprints preserve received bytes; forged type does not change actual format', async () => {
  const bytes = await readFile(new URL('../src-tauri/tests/fixtures/rgba.png', import.meta.url));
  const file = new File([bytes], 'image.webp', { type: 'image/webp' });
  const result = await fingerprintWebFile(file);
  assert.equal(result.format, 'png');
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.bytes, bytes.length);
});

test('unresolved local sources and oversized web sources are not read', async () => {
  let reads = 0;
  const file = {
    size: MAX_IMAGE_BYTES + 1,
    arrayBuffer() {
      reads += 1;
      throw Error('unexpected read');
    },
  };
  assert.deepEqual(await inspectResolvedFiles([file], { kind: 'unresolved' }), []);
  await assert.rejects(fingerprintWebFile(file), /limit/u);
  assert.equal(reads, 0);
});

test('custom-scheme contexts can hash encoded web bytes through a binary fallback', async () => {
  const bytes = await readFile(new URL('../src-tauri/tests/fixtures/rgba.png', import.meta.url));
  const file = new File([bytes], 'image.png', { type: 'image/png' });
  const previous = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
  });
  try {
    let calls = 0;
    const result = await fingerprintWebFile(file, async (raw) => {
      calls += 1;
      assert.ok(raw instanceof Uint8Array);
      assert.deepEqual(Buffer.from(raw), bytes);
      return createHash('sha256').update(raw).digest('hex');
    });
    assert.equal(calls, 1);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    await assert.rejects(fingerprintWebFile(file), /unavailable/u);
    await assert.rejects(
      fingerprintWebFile(file, async () => 'not-a-hash'),
      /Invalid SHA/u,
    );
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: previous });
  }
});
