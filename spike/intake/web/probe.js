'use strict';

import {
  displayedUrl,
  fingerprintWebFile,
  hasWebImageSource,
  originalImageCandidate,
  resolveDrop,
} from './drop-resolution.mjs';

const $ = (id) => document.getElementById(id);
const records = [];
let environment = { userAgent: navigator.userAgent, href: location.href, origin: location.origin };
let previewUrl;
let additionalReceiverInstalled = false;
let additionalReceiverRequested = false;
let macCaptureId = null;
let macCaptureCompleting = false;
let macBridgeInstalled = false;
let internalDrag = false;
let originalCandidate = null;
let originalImageReading = false;

const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');

function record(type, data, context = currentContext()) {
  records.push({ at: new Date().toISOString(), type, ...context, data });
  $('log').textContent = JSON.stringify(records.slice(-30), null, 2);
}

function currentContext() {
  return { versions: $('versions').value, source: $('source').value, case: $('case').value };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function decodeImage(file, context, actualFormat = null) {
  if (!actualFormat && !file.type.startsWith('image/')) return;
  const started = performance.now();
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    record(
      'html-image-decoded',
      {
        name: file.name,
        width: image.naturalWidth,
        height: image.naturalHeight,
        bytes: file.size,
        elapsedMs: performance.now() - started,
      },
      context,
    );
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
    $('preview').src = url;
    $('preview').hidden = false;
  };
  image.onerror = () => {
    record('html-image-decode-error', { name: file.name, elapsedMs: performance.now() - started }, context);
    URL.revokeObjectURL(url);
  };
  image.src = url;
}

function sourceCandidate(strings) {
  const html = strings['text/html'] ?? '';
  const imageSources = [];
  if (html.length <= 65536) {
    // A detached template is inert: parsing source metadata must not request
    // remote images before the user explicitly chooses the URL read action.
    const template = document.createElement('template');
    template.innerHTML = html;
    for (const image of template.content.querySelectorAll('img[src]')) {
      imageSources.push(image.getAttribute('src'));
    }
  }
  return {
    candidate: originalImageCandidate({ uriList: strings['text/uri-list'] ?? '', imageSources }),
    webImageSource: hasWebImageSource(imageSources),
  };
}

async function completeMacCapture(captureId, htmlDropId) {
  const api = window.__TAURI__;
  const checked = (result) => {
    if (result.captureId !== captureId || (result.status === 'paired' && result.htmlDropId !== htmlDropId)) {
      throw new Error('Native capture response belongs to another drop');
    }
    return result;
  };
  let result = checked(await api.core.invoke('finish_macos_drop_capture', { captureId, htmlDropId }));
  const deadline = performance.now() + 1000;
  while (result.status === 'pending' && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    result = checked(await api.core.invoke('macos_drop_capture_status', { captureId }));
  }
  return result.status === 'pending' ? { status: 'unmatched', reason: 'native-drop-not-received' } : result;
}

async function resolveDroppedFiles(files, source, context, captureId, original) {
  let capture = null;
  const macHtml = environment.os === 'macos' && environment.nativeDragDrop === false;
  const ownsCapture = macHtml && Boolean(captureId);
  try {
    if (ownsCapture) {
      macCaptureCompleting = true;
      $('mac-capture').disabled = true;
      capture = await completeMacCapture(captureId, context.htmlDropId);
      record('macos-drop-capture', capture, context);
    }
    const resolution = resolveDrop(capture, source.candidate, source.webImageSource);
    record('drop-resolution', { htmlDropId: context.htmlDropId, ...resolution }, context);
    if (macHtml && resolution.kind !== 'web') {
      // File paths are authoritative. Do not read local JPEG/RAW bytes or a
      // directory just to manufacture the path missing from browser File.path.
      return;
    }
    for (const [index, file] of files.entries()) {
      let actualFormat = null;
      if (resolution.kind === 'web') {
        try {
          const fallbackHash = window.__TAURI__
            ? (bytes) => window.__TAURI__.core.invoke('hash_web_drop_bytes', bytes)
            : undefined;
          const fingerprint = await fingerprintWebFile(file, fallbackHash);
          actualFormat = fingerprint.format;
          if (original) original.fingerprints.push(fingerprint);
          record('html-file-bytes', { htmlDropId: context.htmlDropId, index, ...fingerprint }, context);
        } catch (error) {
          record('html-file-bytes-error', { index, error: errorText(error) }, context);
          continue;
        }
      }
      decodeImage(file, context, actualFormat);
    }
  } catch (error) {
    record('drop-resolution-error', { error: errorText(error) }, context);
  } finally {
    if (original) {
      original.fingerprintsComplete = true;
      if (originalCandidate === original && !originalImageReading) {
        $('original-image').disabled = !window.__TAURI__ || environment.originalImageUrlReadEnabled === false;
      }
    }
    if (ownsCapture) {
      macCaptureCompleting = false;
      $('mac-capture').disabled = !macBridgeInstalled;
      $('mac-capture-status').textContent = '本轮已结束；下一次拖入前请重新准备。';
    }
  }
}

function inspectTransfer(transfer, type, trustedInput) {
  if (!transfer) return;
  const context = { ...currentContext(), htmlDropId: newId() };
  const files = Array.from(transfer.files);
  // Capture strings and File objects synchronously while DataTransfer is live.
  const strings = Object.fromEntries(
    ['text/uri-list', 'text/html', 'text/plain'].map((format) => [format, transfer.getData(format)]),
  );
  record(
    type,
    {
      trustedInput,
      types: Array.from(transfer.types),
      items: Array.from(transfer.items).map((item) => {
        const entry = item.webkitGetAsEntry?.();
        return { kind: item.kind, type: item.type, isDirectory: entry?.isDirectory ?? null };
      }),
      files: files.map((file) => ({
        name: file.name,
        type: file.type,
        bytes: file.size,
        // Not a standard browser API; record absence instead of inventing a path.
        path: typeof file.path === 'string' ? file.path : null,
        relativePath: file.webkitRelativePath,
      })),
      strings: Object.fromEntries(
        Object.keys(strings).map((format) => {
          const text = strings[format];
          return [format, { length: text.length, preview: text.slice(0, 4096) }];
        }),
      ),
    },
    context,
  );
  if (type === 'html-drop') {
    const source = sourceCandidate(strings);
    const candidate = source.candidate;
    const captureId = trustedInput ? macCaptureId : null;
    if (trustedInput) macCaptureId = null; // A second drop cannot reuse a prepared capture.
    originalCandidate = candidate
      ? { ...candidate, context, fingerprints: [], fingerprintsComplete: false, fileCount: files.length }
      : null;
    // Do not offer a final byte comparison while this drop still has unread
    // Files. A subsequent drop owns its own readiness and immutable records.
    $('original-image').disabled = true;
    $('original-image-status').textContent = candidate
      ? `可显式读取来源 URL：${displayedUrl(candidate.url).url}（不会自动请求）`
      : '没有唯一的 HTTP(S) 图片 URL；不会猜测地址或下载网页。';
    if (candidate)
      record(
        'original-image-source',
        {
          ...displayedUrl(candidate.url),
          provenance: candidate.provenance,
        },
        context,
      );
    void resolveDroppedFiles(files, source, context, captureId, originalCandidate);
  } else {
    files.forEach((file) => decodeImage(file, context));
  }
  if ($('additional').checked && type === 'html-drop') {
    const bridge = window.chrome?.webview;
    try {
      if (typeof bridge?.postMessageWithAdditionalObjects !== 'function') {
        throw new Error('postMessageWithAdditionalObjects unavailable');
      }
      // Wry's existing IPC handler expects a string; object messages stop later COM subscribers.
      bridge.postMessageWithAdditionalObjects(JSON.stringify({ type: 'intake-spike', context }), files);
      record(
        'additional-objects-sent',
        { files: files.length, nativeReceiverInstalled: additionalReceiverInstalled },
        context,
      );
    } catch (error) {
      record('additional-objects-error', { error: errorText(error) }, context);
    }
  }
}

// Prevent navigation even when the file is released outside the test box.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('dragstart', () => {
  internalDrag = true;
  macCaptureId = null;
});
document.addEventListener('dragend', () => {
  internalDrag = false;
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  $('drop').classList.remove('over');
  if (internalDrag) {
    record('internal-drop-ignored', { trustedInput: event.isTrusted });
    internalDrag = false;
    return;
  }
  inspectTransfer(event.dataTransfer, 'html-drop', event.isTrusted);
});
$('drop').addEventListener('dragenter', (event) => {
  event.preventDefault();
  $('drop').classList.add('over');
  record('html-enter', { types: Array.from(event.dataTransfer?.types ?? []) });
});
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('paste', (event) => {
  event.preventDefault();
  inspectTransfer(event.clipboardData, 'html-paste', event.isTrusted);
});
$('clipboard').addEventListener('click', async () => {
  const context = currentContext();
  const started = performance.now();
  $('clipboard').disabled = true;
  record('clipboard-start', {}, context);
  try {
    const result = await window.__TAURI__.core.invoke('read_system_clipboard', {
      imageMode: $('clipboard-mode').value,
    });
    record('system-clipboard', { ...result, roundTripMs: performance.now() - started }, context);
  } catch (error) {
    record('clipboard-error', { error: errorText(error), roundTripMs: performance.now() - started }, context);
  } finally {
    $('clipboard').disabled = false;
  }
});
$('export').addEventListener('click', async () => {
  const data = {
    schema: 1,
    environment,
    currentContext: currentContext(),
    exportedAt: new Date().toISOString(),
    records,
  };
  if (window.__TAURI__) {
    try {
      const path = await window.__TAURI__.core.invoke('save_report', { report: data });
      record('report-saved', { path });
    } catch (error) {
      record('report-save-error', { error: errorText(error) });
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `intake-spike-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('clear').addEventListener('click', () => {
  records.length = 0;
  $('log').textContent = '';
});
$('observation').addEventListener('click', () => record('manual-observation', {}));
$('mac-capture').addEventListener('click', async () => {
  if (macCaptureCompleting) return;
  $('mac-capture').disabled = true;
  try {
    const captureId = newId();
    const result = await window.__TAURI__.core.invoke('arm_macos_drop_capture', { captureId });
    macCaptureId = captureId;
    record('macos-capture-armed', result);
    $('mac-capture-status').textContent = '已准备：现在只拖入一次；本轮不按文件名推测路径。';
  } catch (error) {
    macCaptureId = null;
    record('macos-capture-arm-error', { error: errorText(error) });
  } finally {
    $('mac-capture').disabled = false;
  }
});
$('original-image').addEventListener('click', async () => {
  const candidate = originalCandidate;
  if (!candidate?.fingerprintsComplete || originalImageReading) return;
  originalImageReading = true;
  $('original-image').disabled = true;
  try {
    const result = await window.__TAURI__.core.invoke('read_original_image_url', { url: candidate.url });
    const representations = candidate.fingerprints.map((file) => ({ ...file }));
    record(
      'original-image-response',
      {
        ...result,
        receivedRepresentations: representations,
        receivedRepresentationsComplete: representations.length === candidate.fileCount,
        identicalToReceivedFile: representations.some((file) => file.sha256 === result.sha256)
          ? true
          : representations.length > 0 && representations.length === candidate.fileCount
            ? false
            : null,
      },
      candidate.context,
    );
    if (originalCandidate === candidate) {
      $('original-image-status').textContent = '已校验原始 URL 的响应；实际格式和字节摘要见记录。';
    }
  } catch (error) {
    record('original-image-error', { error: errorText(error) }, candidate.context);
  } finally {
    originalImageReading = false;
    $('original-image').disabled =
      !originalCandidate?.fingerprintsComplete || environment.originalImageUrlReadEnabled === false;
  }
});

async function initialize() {
  const api = window.__TAURI__;
  if (!api) {
    $('environment').textContent = '普通浏览器：只能测试 HTML5 事件；系统剪贴板与原生拖放需要 Tauri。';
    record('environment', environment);
    return;
  }
  try {
    environment = { ...environment, ...(await api.core.invoke('environment')) };
    $('environment').textContent = JSON.stringify(environment);
    record('environment', environment);
    await api.webview.getCurrentWebview().onDragDropEvent((event) => {
      record(`native-${event.payload.type}`, event.payload);
      $('drop').classList.toggle('over', ['enter', 'over'].includes(event.payload.type));
    });
    if (environment.os === 'macos' && environment.nativeDragDrop === false) {
      $('mac-capture').hidden = false;
      $('mac-capture-status').hidden = false;
      await api.event.listen('spike-macos-drop', ({ payload }) => record('macos-native-drag', payload));
      try {
        const installed = await api.core.invoke('install_macos_drag_bridge');
        macBridgeInstalled = true;
        record('macos-bridge-installed', installed);
        $('mac-capture').disabled = false;
        $('mac-capture-status').textContent = '桥接已安装；每次测试前点击“准备一次 Mac 拖入”。';
      } catch (error) {
        record('macos-bridge-install-error', { error: errorText(error) });
        $('mac-capture-status').textContent = '路径桥接未安装：仅记录 HTML 数据，不推测本地路径。';
      }
    }
    if (environment.os === 'windows') {
      await api.event.listen('spike-additional-paths', ({ payload }) => {
        if (payload.phase === 'register') additionalReceiverInstalled = payload.ok;
        record('additional-paths', payload, payload.context ?? currentContext());
      });
      $('additional').addEventListener('change', async () => {
        if (!$('additional').checked || additionalReceiverRequested) return;
        additionalReceiverRequested = true;
        try {
          await api.core.invoke('install_additional_receiver');
        } catch (error) {
          record('additional-receiver-error', { error: errorText(error) });
        }
      });
    }
    $('clipboard').disabled = false;
  } catch (error) {
    record('initialization-error', { error: errorText(error) });
    $('environment').textContent = `初始化失败：${errorText(error)}`;
  }
}

initialize();
