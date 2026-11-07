// Injected into the unmodified release WebView; never bundled with the app.
(() => {
  if (window.baseline) throw Error('Observer already installed; use a fresh process');
  const data = (window.baseline = {
    schema: 'rapidraw-task1-baseline',
    measurementVersion: 3,
    clicks: [],
    frames: [],
    errors: [],
    selectionHistory: [],
    keyboardEvents: 0,
    sourceFileAccessTraced: false,
    installedAt: performance.now(),
  });
  let active = null,
    armed = null,
    switching = false,
    drag = null;
  const propsAbove = (node, predicate) => {
    let fiber = node?.[Object.keys(node).find((key) => key.startsWith('__reactFiber$'))];
    while (fiber) {
      let root = fiber;
      while (root.return) root = root.return;
      const current = root.stateNode?.current === root ? fiber : fiber.alternate;
      if (current && predicate(current.memoizedProps)) return current.memoizedProps;
      fiber = fiber.return;
    }
    return null;
  };
  const thumbnails = () => [...document.querySelectorAll('[data-tooltip^="photo-"]')];
  data.nodePath = (node) => propsAbove(node, (p) => !!p?.imageFile?.path)?.imageFile.path;
  data.filmstrip = () => propsAbove(thumbnails()[0], (p) => p?.selectedImage && Array.isArray(p.imageList));
  const selectedPath = () => data.filmstrip()?.selectedImage?.path;
  const fail = (message) => {
    data.errors.push({ at: performance.now(), message });
  };
  const tick = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const visibleRect = (node) => {
    const r = node.getBoundingClientRect();
    let left = Math.max(0, r.left),
      top = Math.max(0, r.top);
    let right = Math.min(innerWidth, r.right),
      bottom = Math.min(innerHeight, r.bottom);
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent),
        bounds = parent.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  };
  data.thumbnailCoverage = (selector = '[data-bench-id="thumbnail"]') => {
    // Count containers first: a placeholder with no img must count as missing.
    const containers = [...document.querySelectorAll(selector)].filter(visibleRect);
    const items = containers.map((node) => ({
      loaded: [...node.querySelectorAll('img')].some(
        (img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0,
      ),
    }));
    const loaded = items.filter((item) => item.loaded).length;
    return {
      at: performance.now(),
      mounted: document.querySelectorAll(selector).length,
      expected: items.length,
      loaded,
      missing: items.length - loaded,
      items,
    };
  };
  data.presetPanel = () => {
    // Inspect mounted draggable cards and the actual English panel heading,
    // not settings. Offscreen cards count as mounted, never as visible.
    const headings = [...document.querySelectorAll('p,span,h1,h2,h3,div')].filter(
      (node) => node.childElementCount === 0 && node.textContent === 'Presets' && visibleRect(node),
    );
    if (headings.length > 1) throw Error('Ambiguous visible Presets heading');
    const panel = headings[0]?.parentElement.parentElement;
    const cards = [...document.querySelectorAll('[role="button"][aria-roledescription="draggable"]')]
      .map((node) => ({ node, preset: propsAbove(node, (p) => !!p?.preset?.id && !!p.onApply)?.preset }))
      .filter(({ preset }) => preset)
      .map(({ node, preset }) => ({
        id: preset.id,
        name: preset.name,
        inPanel: !!panel?.contains(node),
        visible: !!visibleRect(node),
      }));
    return {
      at: performance.now(),
      visible: !!panel && !!visibleRect(panel),
      panelRect: panel ? visibleRect(panel) : null,
      mountedCardCount: cards.length,
      visibleCardCount: cards.filter((card) => card.visible && card.inPanel).length,
      cards,
    };
  };
  data.scroller = () => {
    let node = thumbnails()[0];
    while (node && node.scrollWidth <= node.clientWidth + 10) node = node.parentElement;
    if (!node) throw Error('No horizontal filmstrip scroller');
    return node;
  };
  data.reveal = async (path) => {
    const scroller = data.scroller();
    scroller.scrollLeft = 0;
    for (let i = 0; i < 500; i++) {
      await tick();
      await tick();
      const matches = thumbnails().filter((node) => data.nodePath(node) === path);
      if (matches.length > 1) throw Error('Ambiguous thumbnail path: ' + path);
      if (matches.length === 1) {
        const node = matches[0];
        node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        await tick();
        await tick();
        if (data.nodePath(node) !== path) throw Error('Thumbnail recycled while revealing');
        const r = visibleRect(node);
        if (!r) throw Error('Target is not visible');
        const point = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
        if (!node.contains(document.elementFromPoint(point.x, point.y))) throw Error('Target is occluded');
        return point;
      }
      if (scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1) break;
      scroller.scrollLeft += scroller.clientWidth * 0.75;
    }
    throw Error('Target path not rendered: ' + path);
  };
  data.startSwitches = () => {
    if (switching || active || armed || !selectedPath()) throw Error('Invalid switch phase');
    if (data.selectionHistory.at(-1)?.path !== selectedPath())
      data.selectionHistory.push({ at: performance.now(), path: selectedPath() });
    switching = true;
    return {
      start: performance.now(),
      initialPath: selectedPath(),
      seenPaths: [...new Set([...data.selectionHistory.map((e) => e.path), selectedPath()])],
    };
  };
  data.arm = (sample) => {
    if (!switching || active || armed || selectedPath() === sample.targetPath) throw Error('Invalid click arm');
    if (thumbnails().filter((node) => data.nodePath(node) === sample.targetPath).length !== 1)
      throw Error('Target path missing or ambiguous');
    armed = { ...sample, oldPath: selectedPath() };
  };
  document.addEventListener(
    'keydown',
    (event) => {
      if (switching) {
        data.keyboardEvents++;
        fail('Keyboard input during switch phase: ' + event.key);
      }
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      const node = event.target.closest?.('[data-tooltip^="photo-"]');
      if (!node || !switching) return;
      if (!armed || active) {
        fail('Unarmed or overlapping filmstrip click');
        return;
      }
      const actualPath = data.nodePath(node);
      active = { ...armed, actualPath, name: node.dataset.tooltip, start: performance.now() };
      armed = null;
      data.clicks.push(active);
      if (!event.isTrusted || actualPath !== active.targetPath || selectedPath() !== active.oldPath)
        fail('Click target/path changed or untrusted click');
    },
    true,
  );
  data.finish = async () => {
    await tick();
    await tick();
    if (!active || !active.readyAt || !active.previewAt || selectedPath() !== active.targetPath || data.errors.length)
      throw Error('Incomplete or invalid switch');
    active.end = performance.now();
    active.finalPath = selectedPath();
    active.assertions = {
      targetMatched: active.actualPath === active.targetPath,
      selectionStable: true,
      keyboardFree: data.keyboardEvents === 0,
    };
    const row = active;
    active = null;
    return row;
  };
  data.endSwitches = () => {
    if (active || armed || data.errors.length || data.keyboardEvents) throw Error('Invalid switch phase completion');
    switching = false;
    return {
      end: performance.now(),
      errors: data.errors,
      keyboardEvents: data.keyboardEvents,
      selectionHistory: data.selectionHistory,
    };
  };
  data.beginDrag = (element, targetPath) => {
    if (switching || active || drag || !selectedPath()) throw Error('Drag must be isolated from switches');
    const props = data.filmstrip();
    const initialEdited = props.imageList.find((image) => image.path === targetPath)?.is_edited === true;
    if (selectedPath() !== targetPath || !props.selectedImage.isReady || !initialEdited)
      throw Error('Drag target must be the explicit ready edited fixture');
    drag = {
      element,
      targetPath,
      initialEdited,
      initialPath: selectedPath(),
      before: element.value,
      pathChanges: [],
      samples: 0,
      trustedEvents: [],
      start: performance.now(),
    };
  };
  for (const type of ['mousedown', 'mousemove', 'mouseup'])
    document.addEventListener(
      type,
      (event) => {
        if (!drag) return;
        if (type !== 'mousemove' || event.buttons === 1)
          drag.trustedEvents.push({ type, trusted: event.isTrusted, at: performance.now() });
        const path = selectedPath();
        if (path !== drag.initialPath) drag.pathChanges.push({ path, at: performance.now() });
      },
      true,
    );
  data.finishDrag = async () => {
    await tick();
    await tick();
    if (!drag) throw Error('No drag');
    const { element, ...result } = drag;
    result.after = element.value;
    result.finalPath = selectedPath();
    result.end = performance.now();
    result.assertions = {
      valueChanged: result.before !== result.after,
      editedTarget: result.initialEdited && result.initialPath === result.targetPath,
      pathUnchanged: result.pathChanges.length === 0 && result.finalPath === result.initialPath,
      trustedMouse:
        ['mousedown', 'mousemove', 'mouseup'].every((type) =>
          result.trustedEvents.some((e) => e.type === type && e.trusted),
        ) && result.trustedEvents.every((e) => e.trusted),
      isolated: data.clicks.length === 0 && !switching,
      elementConnected: element.isConnected,
    };
    drag = null;
    return result;
  };
  // SVG candidates are bound to the *current* ImageCanvas props, not whichever
  // unrelated SVG or old fade layer happens to be first in the document.
  const candidates = (path) =>
    [...document.querySelectorAll('svg image')].filter((node) => {
      const p = propsAbove(node, (p) => p?.selectedImage && Object.hasOwn(p, 'finalPreviewUrl'));
      const href = node.getAttribute('href');
      return (
        p?.selectedImage.path === path &&
        href &&
        href === (p.finalPreviewUrl || p.selectedImage.thumbnailUrl) &&
        visibleRect(node)
      );
    });
  const pending = new WeakMap();
  const observe = () => {
    const at = performance.now(),
      selected = data.filmstrip()?.selectedImage;
    if (selected?.path && data.selectionHistory.at(-1)?.path !== selected.path) {
      data.selectionHistory.push({ at, path: selected.path });
      if (
        switching &&
        (!active ||
          (selected.path !== active.oldPath && selected.path !== active.targetPath) ||
          (active.selectedAt && selected.path !== active.targetPath))
      )
        fail('Unexpected selection during switches');
    }
    if (drag) {
      drag.samples++;
      if (selected?.path !== drag.initialPath) drag.pathChanges.push({ at, path: selected?.path ?? null });
    }
    const click = active;
    if (click && selected?.path === click.targetPath) {
      click.selectedAt ??= at;
      if (selected.isReady) {
        click.readyAt ??= at;
        click.readyPath ??= selected.path;
      }
      if (!click.previewAt) {
        for (const node of candidates(click.targetPath)) {
          const href = node.getAttribute('href');
          if (pending.get(node)?.click === click && pending.get(node)?.href === href) continue;
          const token = { click, href };
          pending.set(node, token);
          const image = new Image();
          image.src = href;
          image
            .decode()
            .then(() =>
              requestAnimationFrame(() => {
                if (
                  active !== click ||
                  pending.get(node) !== token ||
                  selectedPath() !== click.targetPath ||
                  !node.isConnected ||
                  !candidates(click.targetPath).includes(node) ||
                  node.getAttribute('href') !== href
                )
                  return;
                if (!click.previewAt)
                  Object.assign(click, {
                    previewAt: performance.now(),
                    previewPath: click.targetPath,
                    previewMethod: 'svg-decode-raf',
                    previewHref: href,
                  });
              }),
            )
            .catch(() => {
              if (pending.get(node) === token) pending.delete(node);
            });
        }
        const frame = data.frames.find((frame) => frame.at >= click.start && frame.path === click.targetPath);
        if (frame && !click.gpuPending) {
          click.gpuPending = true;
          requestAnimationFrame(() => {
            if (active === click && selectedPath() === click.targetPath && !click.previewAt)
              Object.assign(click, {
                previewAt: performance.now(),
                previewPath: frame.path,
                previewMethod: 'wgpu-frame-ready-raf',
                gpuFrameAt: frame.at,
              });
          });
        }
      }
    }
    requestAnimationFrame(observe);
  };
  const callback = window.__TAURI_INTERNALS__.transformCallback((event) => {
    data.frames.push({ at: performance.now(), path: event.payload?.path });
  });
  data.listenerReady = false;
  window.__TAURI_INTERNALS__
    .invoke('plugin:event|listen', { event: 'wgpu-frame-ready', target: { kind: 'Any' }, handler: callback })
    .then(() => {
      data.listenerReady = true;
    })
    .catch((error) => fail(String(error)));
  requestAnimationFrame(observe);
  data.status = () => ({
    at: performance.now(),
    selected: data.filmstrip()?.selectedImage,
    imageCount: data.filmstrip()?.imageList.length,
    thumbs: thumbnails().map((node) => ({
      name: node.dataset.tooltip,
      path: data.nodePath(node),
      rect: node.getBoundingClientRect().toJSON(),
    })),
  });
})();
