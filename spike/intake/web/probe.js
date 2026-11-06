'use strict';

const $ = (id) => document.getElementById(id);
const records = [];
let environment = { userAgent: navigator.userAgent };
let previewUrl;

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

function decodeImage(file, context) {
  if (!file.type.startsWith('image/')) return;
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

function inspectTransfer(transfer, type) {
  if (!transfer) return;
  const context = currentContext();
  const files = Array.from(transfer.files);
  record(
    type,
    {
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
        ['text/uri-list', 'text/html', 'text/plain'].map((format) => {
          const text = transfer.getData(format);
          return [format, { length: text.length, preview: text.slice(0, 4096) }];
        }),
      ),
    },
    context,
  );
  files.forEach((file) => decodeImage(file, context));
  if ($('additional').checked && type === 'html-drop') {
    const bridge = window.chrome?.webview;
    try {
      if (typeof bridge?.postMessageWithAdditionalObjects !== 'function') {
        throw new Error('postMessageWithAdditionalObjects unavailable');
      }
      bridge.postMessageWithAdditionalObjects({ type: 'intake-spike', context }, files);
      record('additional-objects-sent', { files: files.length, nativeReceiverInstalled: false }, context);
    } catch (error) {
      record('additional-objects-error', { error: errorText(error) }, context);
    }
  }
}

// Prevent navigation even when the file is released outside the test box.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
  event.preventDefault();
  $('drop').classList.remove('over');
  inspectTransfer(event.dataTransfer, 'html-drop');
});
$('drop').addEventListener('dragenter', (event) => {
  event.preventDefault();
  $('drop').classList.add('over');
  record('html-enter', { types: Array.from(event.dataTransfer?.types ?? []) });
});
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('paste', (event) => {
  event.preventDefault();
  inspectTransfer(event.clipboardData, 'html-paste');
});
$('clipboard').addEventListener('click', async () => {
  const context = currentContext();
  const started = performance.now();
  $('clipboard').disabled = true;
  record('clipboard-start', {}, context);
  try {
    const result = await window.__TAURI__.core.invoke('read_system_clipboard');
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
    $('clipboard').disabled = false;
  } catch (error) {
    record('initialization-error', { error: errorText(error) });
    $('environment').textContent = `初始化失败：${errorText(error)}`;
  }
}

initialize();
