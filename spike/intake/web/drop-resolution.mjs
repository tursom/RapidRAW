// Pure resolution rules shared by the probe and its offline regression checks.
export const MAX_IMAGE_BYTES = 128 * 1024 * 1024;

export function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function displayedUrl(value) {
  const accepted = imageUrl(value);
  if (!accepted) return null;
  const url = new URL(accepted);
  return { url: `${url.origin}${url.pathname}`, queryOmitted: Boolean(url.search) };
}

export function originalImageCandidate({ uriList = '', imageSources = [] } = {}) {
  const images = [...new Set(imageSources.map(imageUrl).filter(Boolean))];
  if (images.length > 1) return null;
  if (images.length === 1) return { url: images[0], provenance: 'html-img-src' };
  if (uriList.length > 16384) return null;
  const uris = [
    ...new Set(
      uriList
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map(imageUrl)
        .filter(Boolean),
    ),
  ];
  return uris.length === 1 ? { url: uris[0], provenance: 'uri-list' } : null;
}

export function hasWebImageSource(imageSources) {
  // These are provenance hints for an already delivered File, never URLs to
  // fetch. A blob/data/relative source can still deliver useful image bytes.
  return imageSources.some((source) => {
    if (typeof source !== 'string' || !source.trim()) return false;
    const value = source.trim();
    if (/^data:image\//iu.test(value)) return true;
    if (/^blob:https?:\/\//iu.test(value)) return true;
    try {
      return ['http:', 'https:'].includes(new URL(value, 'https://source.invalid/').protocol);
    } catch {
      return false;
    }
  });
}

export function resolveDrop(capture, candidate, webImageSource = false) {
  // Only an explicitly paired capture may authorize native paths. Never infer
  // a path from File.name, a previous drop, or a timing/position heuristic.
  if (capture?.status === 'paired' && Array.isArray(capture.paths) && capture.paths.length) {
    if (!capture.paths.every((path) => typeof path === 'string' && path.length)) {
      return { kind: 'unresolved', reason: 'invalid-native-paths' };
    }
    return { kind: 'files', paths: capture.paths, acquisition: 'native-drag-pasteboard' };
  }
  if ((candidate && imageUrl(candidate.url)) || webImageSource) {
    return { kind: 'web', acquisition: 'html-file', source: candidate ? displayedUrl(candidate.url) : null };
  }
  return { kind: 'unresolved', reason: capture?.status ?? 'no-paired-native-capture' };
}

export function imageSignature(bytes) {
  const prefix = (values) => values.every((value, index) => bytes[index] === value);
  if (prefix([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (prefix([255, 216, 255])) return 'jpeg';
  if (prefix([71, 73, 70, 56]) && [55, 57].includes(bytes[4]) && bytes[5] === 97) return 'gif';
  if (prefix([66, 77])) return 'bmp';
  if (prefix([73, 73, 42, 0]) || prefix([77, 77, 0, 42])) return 'tiff';
  if (
    prefix([82, 73, 70, 70]) &&
    bytes.length >= 12 &&
    [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)
  )
    return 'webp';
  return null;
}

export async function fingerprintWebFile(file, fallbackHash) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    throw new Error('Received image exceeds the 128 MiB limit or is empty');
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Received image size changed during reading');
  }
  const format = imageSignature(new Uint8Array(bytes));
  if (!format) throw new Error('Received File has no supported image signature');
  let sha256;
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    sha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  } else if (fallbackHash) {
    // Some embedded custom-scheme contexts do not expose SubtleCrypto. Send
    // encoded web bytes through binary IPC, never a JSON array or local RAW.
    sha256 = await fallbackHash(new Uint8Array(bytes));
  } else {
    throw new Error('SHA-256 is unavailable in this context');
  }
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid SHA-256 response');
  return {
    name: file.name,
    advertisedType: file.type,
    format,
    bytes: bytes.byteLength,
    sha256,
    validation: 'signature-and-byte-hash; full decode is recorded separately',
  };
}

export async function inspectResolvedFiles(files, resolution, inspect = fingerprintWebFile) {
  if (resolution.kind !== 'web') return [];
  return Promise.all(files.map((file) => inspect(file)));
}
