"""Task 3: trusted-input smoke controller for the real Windows release.

Parent session builds, copies windows-cdp.py/observe.js to ROOT, supplies the
NASA fixture and fixture.json, runs this in the interactive desktop, and archives
evidence. This file is intentionally not a mock-host test. No production React
callback, setter, or props object is called or changed by this controller.

Runtime writes are limited to this fork's two backed-up profile files, disposable
fixture sidecars/thumbnails, logs, evidence, and fixture/output. Existing evidence
or output is refused. Run once per fresh task directory. No save dialog is used.
Keyboard defaults are read from ROOT/keyboardUtils.ts (preferred frozen copy) or
BASE/app/src/utils/keyboardUtils.ts. Missing/changed interfaces fail with evidence;
the parent owns runtime fixes after this script's static-check handoff.
"""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import time
import traceback
import zlib


ROOT = Path(r"E:\projects\tbt\rapidraw-curves")
BASE = Path(r"E:\projects\tbt\rapidraw-baseline")
EXE = BASE / "app/src-tauri/target/release/RapidRAW-curves.exe"
PHOTO = ROOT / "fixture/photo-000.NEF"
NASA_SHA256 = "5922721d13f11795557d97fdeb0a60b900086c402bc82a848ff280d15b99ffd4"
OUT = ROOT / "evidence"
OUTPUT = OUT / "windows-smoke.json"
EXPORT_DIR = PHOTO.parent / "output"
EXPORTED = EXPORT_DIR / "photo-000_curves-smoke.jpg"
WATERMARK = OUT / "curves-smoke-watermark.png"
TITLE = "RapidRAW TBT"
PANEL = '[data-panel="curves"][data-panel-region="leftTop"]'
DIALOG = '[role="dialog"][aria-modal="true"]'
GRAPH = 'svg[viewBox="0 0 255 255"]'


def check(condition, message):
    # Do not use Python assert: python -O must not disable acceptance gates.
    if not condition:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


# Observation only: current fibers, DOM marks, event listeners and a fetch
# wrapper which returns the ORIGINAL Promise and reads only cloned IPC responses.
# Window capture runs before the modal's document Escape stopImmediatePropagation.
OBSERVER_JS = r"""(() => {
  if (window.curvesSmoke) throw Error('Smoke observer already installed');
  const s = window.curvesSmoke = {events: [], calls: [], nativeEvents: [],
    selectionChanges: [], caseName: 'setup', armed: false, expectedPath: null};
  s.props = (node, predicate) => {
    let fiber = node?.[Object.keys(node).find(k => k.startsWith('__reactFiber$'))];
    while (fiber) {
      let root = fiber; while (root.return) root = root.return;
      const current = root.stateNode?.current === root ? fiber : fiber.alternate;
      if (current && predicate(current.memoizedProps)) return current.memoizedProps;
      fiber = fiber.return;
    }
    return null;
  };
  s.visible = node => {
    if (!node?.isConnected) return false;
    const r = node.getBoundingClientRect();
    let l = Math.max(0, r.left), t = Math.max(0, r.top);
    let b = Math.min(innerHeight, r.bottom), rr = Math.min(innerWidth, r.right);
    for (let p = node; p; p = p.parentElement) {
      const css = getComputedStyle(p), pr = p.getBoundingClientRect();
      if (css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0) return false;
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {l = Math.max(l, pr.left); rr = Math.min(rr, pr.right);}
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {t = Math.max(t, pr.top); b = Math.min(b, pr.bottom);}
    }
    return rr > l && b > t;
  };
  s.mark = (node, role) => {
    if (!node) throw Error('Missing target: ' + role);
    node.setAttribute('data-curves-smoke-role', role); return node;
  };
  s.one = (selector, scope = document) => {
    const nodes = [...scope.querySelectorAll(selector)].filter(s.visible);
    if (nodes.length !== 1) throw Error('Expected one visible target ' + selector + ', got ' + nodes.length);
    return nodes[0];
  };
  s.attached = selector => {
    const nodes = [...document.querySelectorAll(selector)].filter(node => node.isConnected);
    if (nodes.length !== 1) throw Error('Expected one attached target ' + selector + ', got ' + nodes.length);
    return nodes[0];
  };
  s.header = () => s.one('[data-panel="curves"][data-panel-region="leftTop"] button[aria-label="Info"]')
    .parentElement.parentElement;
  s.graphs = () => [...document.querySelectorAll('svg[viewBox="0 0 255 255"]')].map(node => {
    const p = s.props(node, p => p?.adjustments?.curves && typeof p.setAdjustments === 'function');
    if (!p) throw Error('Curve graph has no current props');
    return {node, p, mask: p.isForMask === true, visible: s.visible(node),
      region: node.closest('[data-panel-region]')?.dataset.panelRegion ?? 'compact'};
  });
  s.globalGraph = () => {
    const nodes = s.graphs().filter(g => !g.mask && g.visible);
    if (nodes.length !== 1) throw Error('Expected one visible global curve, got ' + nodes.length);
    return s.mark(nodes[0].node, 'curve-global');
  };
  let cachedCanvas = null;
  const canvasProps = p => p?.selectedImage && typeof p.isCropping === 'boolean' &&
    typeof p.isMasking === 'boolean' && typeof p.isAiEditing === 'boolean';
  s.canvas = () => {
    if (cachedCanvas?.isConnected && s.visible(cachedCanvas)) {
      const p = s.props(cachedCanvas, canvasProps);
      if (p) return {node:cachedCanvas,p};
    }
    for (const node of document.querySelectorAll('div,canvas,svg')) {
      const p = s.props(node, canvasProps);
      if (p && s.visible(node)) {cachedCanvas=node; return {node, p};}
    }
    throw Error('No observable current ImageCanvas props (do not replace this with a UI-store setter)');
  };
  s.mobileTab = panel => {
    const icons = {adjustments:'sliders-horizontal', metadata:'info', export:'file-input'};
    const nodes = [...document.querySelectorAll('button')].filter(node => s.visible(node) &&
      node.querySelector('svg.lucide-' + icons[panel]) &&
      s.props(node, p => typeof p?.onPanelSelect === 'function' && Object.hasOwn(p, 'activePanel')));
    if (nodes.length !== 1) throw Error('Missing/ambiguous mobile tab ' + panel);
    return s.mark(nodes[0], 'mobile-' + panel);
  };
  s.describe = node => ({tag: node?.tagName ?? null, role: node?.getAttribute?.('role'),
    label: node?.getAttribute?.('aria-label'), title: node?.getAttribute?.('title'),
    tooltip: node?.getAttribute?.('data-tooltip'), text: node?.textContent?.trim().slice(0, 140),
    panel: node?.closest?.('[data-panel]')?.dataset.panel,
    tab: node?.closest?.('[data-tab-id]')?.dataset.tabId});
  s.sidebars = () => ['left','right'].map(side => {
    const node = [...document.querySelectorAll('[data-panel-region]')].find(n =>
      n.dataset.panelRegion === side + 'Top' && s.visible(n));
    if (!node) return {side,visible:false};
    const predicate = p => p?.side === side && p.topRegion === side + 'Top' &&
      typeof p.renderPanel === 'function';
    const props = s.props(node, predicate);
    if (!props) throw Error('No current SidePanelArea props for ' + side);
    let root = node;
    while (root.parentElement && s.props(root.parentElement, predicate) === props) root = root.parentElement;
    return {side,visible:s.visible(root),width:root.getBoundingClientRect().width,
      cssWidth:getComputedStyle(root).width,inlineWidth:root.style.width,propWidth:props.width};
  });
  s.watermarkPreview = () => {
    const predicate=p=>typeof p?.imageAspectRatio==='number'&&typeof p.watermarkImageAspectRatio==='number'&&
      typeof p.scale==='number'&&typeof p.spacing==='number'&&Object.hasOwn(p,'watermarkPath');
    const nodes=[...document.querySelectorAll('div[style]')].filter(node=>{
      const p=s.props(node,predicate);
      return p&&s.props(node.parentElement,predicate)!==p;
    });
    if(nodes.length!==1)throw Error('Missing/ambiguous real WatermarkPreview root');
    return {node:nodes[0],p:s.props(nodes[0],predicate)};
  };
  s.watermarkGeometry = () => {
    const {node,p}=s.watermarkPreview();
    const wrappers=[...node.children].filter(n=>n.style.position==='absolute'&&n.style.width);
    if(wrappers.length!==1)throw Error('Missing/ambiguous watermark placeholder wrapper');
    const wrapper=wrappers[0],placeholder=wrapper.firstElementChild,css=getComputedStyle(node);
    if(!placeholder)throw Error('No real watermark placeholder');
    return {props:{imageAspectRatio:p.imageAspectRatio,watermarkImageAspectRatio:p.watermarkImageAspectRatio,
        watermarkPath:p.watermarkPath,anchor:p.anchor,scale:p.scale,spacing:p.spacing,opacity:p.opacity},
      preview:{rect:node.getBoundingClientRect().toJSON(),clientWidth:node.clientWidth,clientHeight:node.clientHeight,
        aspectRatio:node.style.aspectRatio,borderRight:parseFloat(css.borderRightWidth),borderBottom:parseFloat(css.borderBottomWidth)},
      wrapper:{rect:wrapper.getBoundingClientRect().toJSON(),width:wrapper.style.width,right:wrapper.style.right,
        bottom:wrapper.style.bottom,position:wrapper.style.position,opacity:getComputedStyle(wrapper).opacity},
      placeholder:{rect:placeholder.getBoundingClientRect().toJSON(),aspectRatio:placeholder.style.aspectRatio},
      visible:s.visible(node)&&s.visible(placeholder)};
  };
  for (const type of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup',
      'click','contextmenu','keydown','keyup','beforeinput','input']) {
    window.addEventListener(type, e => {
      if (type.endsWith('move') && !e.buttons) return;
      const node = e.target instanceof Element ? e.target : null;
      s.events.push({at:performance.now(), caseName:s.caseName, type, trusted:e.isTrusted,
        role:node?.closest('[data-curves-smoke-role]')?.getAttribute('data-curves-smoke-role') ?? null,
        target:s.describe(node), key:e.key ?? null, code:e.code ?? null, button:e.button ?? null,
        buttons:e.buttons ?? null, ctrl:e.ctrlKey, shift:e.shiftKey, alt:e.altKey,
        x:e.clientX ?? null, y:e.clientY ?? null});
    }, true);
  }
  const internal = window.__TAURI_INTERNALS__, originalFetch = window.fetch;
  const internalsBefore = {invoke:internal.invoke,ipc:internal.ipc,postMessage:internal.postMessage};
  const hook = {verified:false,probe:null,errors:[],transport:'fetch/ipc.localhost'};
  const watched = new Set(['estimate_export_sizes','export_images','get_image_dimensions','is_tethering_supported']);
  const observationError = (row, error) => {
    hook.errors.push({command:row?.command ?? null,error:String(error)});
    if (row) {row.status='observation-error'; row.observationError=String(error);}
  };
  const parseArgs = (row, text) => {
    try {row.args=JSON.parse(text);} catch (error) {observationError(row,error);}
  };
  function observedFetch(...args) {
    let row = null;
    // Never read/record headers (including Tauri's invoke key), load_settings,
    // profile bytes, or service settings. Only allowlisted test command bodies.
    try {
      const input=args[0], url=new URL(typeof input==='string'||input instanceof URL ? String(input) : input.url,location.href);
      const command=decodeURIComponent(url.pathname.slice(1));
      if (url.hostname==='ipc.localhost' && watched.has(command)) {
        row={command,caseName:s.caseName,at:performance.now(),status:'pending'};
        s.calls.push(row);
        if (typeof args[1]?.body==='string') parseArgs(row,args[1].body);
        else if (typeof Request!=='undefined' && input instanceof Request)
          input.clone().text().then(text=>parseArgs(row,text),error=>observationError(row,error));
        else observationError(row,Error('Unsupported watched IPC request body'));
      }
    } catch (error) {observationError(row,error);}
    let promise;
    try {promise=Reflect.apply(originalFetch,this,args);}
    catch (error) {if(row){row.status='error';row.error=String(error);} throw error;}
    if (row) promise.then(response => {
      try {
        row.httpStatus=response.status;
        row.nativeOk=response.headers.get('Tauri-Response')==='ok';
        const clone=response.clone(), type=(clone.headers.get('content-type')||'').split(',')[0];
        if (type!=='application/json' && type!=='text/plain') {
          observationError(row,Error('Unexpected watched IPC response content type')); return;
        }
        const reading=type==='application/json' ? clone.json() : clone.text();
        reading.then(value => {
          if (row.status==='observation-error') return;
          row.status=row.nativeOk ? 'fulfilled' : 'error';
          if(row.nativeOk)row.result=value;else row.error=value;
          row.finishedAt=performance.now();
        }, error=>observationError(row,error));
      } catch (error) {observationError(row,error);}
    }, error=>{row.status='error';row.error=String(error);row.finishedAt=performance.now();});
    return promise;
  }
  window.fetch=observedFetch;
  if (window.fetch!==observedFetch) throw Error('Fetch IPC observer installation failed');
  s.hookStatus = () => ({installed:window.fetch===observedFetch,verified:hook.verified,
    transport:hook.transport,probe:hook.probe,errors:[...hook.errors],
    readOnlyInternalsUnchanged:Object.entries(internalsBefore).every(([key,value])=>internal[key]===value)});
  s.assertHook = () => {
    const status=s.hookStatus();
    if(!status.installed||!status.verified||!status.readOnlyInternalsUnchanged||status.errors.length)
      throw Error('IPC fetch observer is not verified/intact: '+JSON.stringify(status));
  };
  s.probeHook = async () => {
    const start=s.calls.length;
    const value=await internal.invoke('is_tethering_supported');
    const deadline=performance.now()+3000;
    let row;
    do {
      row=s.calls.slice(start).find(c=>c.command==='is_tethering_supported'&&c.status==='fulfilled');
      if(row)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    } while(performance.now()<deadline);
    if(!row||typeof value!=='boolean'||row.result!==value||!row.args)
      throw Error('Real native probe did not traverse the installed fetch IPC observer');
    hook.probe={command:row.command,result:row.result,httpStatus:row.httpStatus,nativeOk:row.nativeOk};
    hook.verified=true;
    s.assertHook();
    return s.hookStatus();
  };
  s.listen = async () => {
    for (const event of ['batch-export-progress','export-complete','export-error']) {
      const handler = internal.transformCallback(e => s.nativeEvents.push({event, payload:e.payload,
        at:performance.now(), caseName:s.caseName}));
      await internal.invoke('plugin:event|listen', {event, target:{kind:'Any'}, handler});
    }
  };
  s.snapshot = () => {
    s.assertHook();
    const canvas = s.canvas(), graphs = s.graphs();
    const global = graphs.find(g => !g.mask && g.visible);
    const adj = global?.p.adjustments;
    const view = s.props(canvas.node, p => ['full','wide','compact'].includes(p?.layoutMode) &&
      typeof p.renderAppPanel === 'function');
    if (!view) throw Error('No current EditorView layoutMode props');
    const exportNode = [...document.querySelectorAll('button')].find(node => s.visible(node) &&
      s.props(node, p => p?.exportState && Array.isArray(p.multiSelectedPaths)));
    const ex = exportNode && s.props(exportNode, p => p?.exportState && Array.isArray(p.multiSelectedPaths));
    const mobile = [...document.querySelectorAll('button')].filter(s.visible).map(node =>
      s.props(node, p => typeof p?.onPanelSelect === 'function' && Object.hasOwn(p, 'activePanel'))).find(Boolean);
    const visibilityNode = document.querySelector('[data-panel="curves"] button[data-tooltip$="Section"]');
    // A reused/bailout fiber's return chain can identify the old alternate.
    // Observe the actual rendered label and icon instead of its cached props.
    const visibilityTooltip = visibilityNode?.getAttribute('data-tooltip');
    if (visibilityNode) {
      if (!['Disable Section','Enable Section'].includes(visibilityTooltip)) throw Error('Unknown visibility label');
      const icon = visibilityNode.querySelector('svg');
      if (!icon?.classList.contains(visibilityTooltip === 'Disable Section' ? 'lucide-eye' : 'lucide-eye-off'))
        throw Error('Visibility label and rendered icon disagree');
    }
    return {selectedPath:baseline.filmstrip()?.selectedImage?.path ?? canvas.p.selectedImage.path,
      canvasPath:canvas.p.selectedImage.path, ready:canvas.p.selectedImage.isReady,
      imageDimensions:{width:canvas.p.selectedImage.width,height:canvas.p.selectedImage.height},
      mode:{crop:canvas.p.isCropping, masks:canvas.p.isMasking, ai:canvas.p.isAiEditing},
      activeMaskContainerId:canvas.p.activeMaskContainerId,
      canvasAttrs:Object.fromEntries([...canvas.node.attributes].map(a => [a.name,a.value])),
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}, layoutMode:view.layoutMode,
      sidebars:s.sidebars(), compactActivePanel:mobile?.activePanel ?? null,
      panels:[...document.querySelectorAll('[data-panel]')].filter(s.visible).map(n =>
        ({panel:n.dataset.panel,region:n.dataset.panelRegion})),
      tabs:[...document.querySelectorAll('[data-tab-id]')].filter(s.visible).map(n => n.dataset.tabId),
      graphs:graphs.map(g => ({mask:g.mask,visible:g.visible,region:g.region})),
      curves:adj?.curves ?? null, pointCurves:adj?.pointCurves ?? null,
      parametricCurve:adj?.parametricCurve ?? null, curveMode:adj?.curveMode ?? null,
      activeTools:adj?.activeTools ?? null,
      curveEnabled:visibilityNode ? visibilityTooltip === 'Disable Section' : null,
      curveVisibilityTooltip:visibilityTooltip ?? null,
      masks:adj?.masks ?? canvas.p.adjustments?.masks ?? null,
      dialogs:[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(s.visible).map(n =>
        ({label:n.getAttribute('aria-label'),rect:n.getBoundingClientRect().toJSON(),text:n.innerText.slice(0,2400)})),
      exportState:ex?.exportState ?? null, exportWorkspace:ex?.appSettings?.workspace ?? null,
      menus:[...document.querySelectorAll('[role="menuitem"]')].filter(s.visible).map(n =>
        ({text:n.innerText,disabled:n.disabled})), selectionChanges:[...s.selectionChanges]};
  };
  const tick = () => {
    if (s.armed) {
      const filmstripPath = baseline.filmstrip()?.selectedImage?.path;
      const canvasPath = s.canvas().p.selectedImage.path;
      if ((filmstripPath && filmstripPath !== s.expectedPath) || canvasPath !== s.expectedPath)
        s.selectionChanges.push({at:performance.now(),filmstripPath,canvasPath});
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()"""


class Smoke:
    def __init__(self, cdp, driver, process, report, hwnd, phase="migration"):
        self.cdp, self.driver, self.process, self.report, self.hwnd = cdp, driver, process, report, hwnd
        self.phase = phase
        self.mask_baseline = None
        self.extras = {}

    def js(self, expression):
        return self.cdp.js(expression)

    def frame(self):
        self.js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

    def snapshot(self):
        return self.js("curvesSmoke.snapshot()")

    def invoke_setup(self, command, args=None):
        self.report["setup"].append({"kind": "native-invoke", "command": command, "phase": self.phase,
                                     "paths": [str(PHOTO)] if args and ("path" in args or "paths" in args) else []})
        return self.js("window.__TAURI_INTERNALS__.invoke(" + json.dumps(command) + "," + json.dumps(args or {}) + ")")

    def point(self, expression, role, fx=0.5, fy=0.5):
        self.js("curvesSmoke.mark((" + expression + ")," + json.dumps(role) +
                ").scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})")
        self.frame()
        return self.js("""(() => {const e=(""" + expression + """),r=e.getBoundingClientRect();
          if(e.disabled)throw Error('Disabled input target');
          const x=r.left+r.width*""" + str(fx) + ",y=r.top+r.height*" + str(fy) + """;
          if(!curvesSmoke.visible(e)||!e.contains(document.elementFromPoint(x,y)))
            throw Error('Input target occluded or outside viewport'); return {x,y};})()""")

    def mouse(self, kind, point, button="left", buttons=None):
        self.cdp.call("Input.dispatchMouseEvent", {"type": kind, **point,
                      "button": button, "buttons": (0 if kind == "mouseReleased" else
                      (2 if button == "right" else 1)) if buttons is None else buttons,
                      "clickCount": 1 if kind != "mouseMoved" else 0})

    def click_expr(self, expression, role, button="left", fx=0.5, fy=0.5):
        point = self.point(expression, role, fx, fy)
        self.mouse("mouseMoved", point, "none", 0)
        self.mouse("mousePressed", point, button)
        self.frame()
        self.mouse("mouseReleased", point, button)
        self.frame()

    def click(self, selector, role):
        # Resolve before scrolling; point() still verifies visibility and hit
        # testing before any trusted mouse event is dispatched.
        self.click_expr("curvesSmoke.attached(" + json.dumps(selector) + ")", role)

    def key(self, code, modifiers=0):
        names = {"Escape": ("Escape", 27), "Enter": ("Enter", 13)}
        key, vk = names.get(code, (code[3:].lower(), ord(code[-1]) if code.startswith("Key") else 0))
        check(vk != 0, "Unsupported CDP key code: " + code)
        for kind in ("keyDown", "keyUp"):
            self.cdp.call("Input.dispatchKeyEvent", {"type": kind, "key": key, "code": code,
                          "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": modifiers})

    def shortcut(self, action):
        combo = self.report["keyboardDefaults"]["combos"][action]
        codes = [part for part in combo if part not in ("ctrl", "shift", "alt")]
        check(len(codes) == 1, "Unsupported shortcut: " + repr(combo))
        self.key(codes[0], sum({"ctrl": 2, "shift": 8, "alt": 1}[p]
                            for p in combo if p in ("ctrl", "shift", "alt")))

    def record(self, name, action, predicate, expected, timeout=12):
        check(bool(expected), "Every case needs explicit trusted input requirements")
        self.extras = {}
        self.js("curvesSmoke.events.length=0;curvesSmoke.caseName=" + json.dumps(name))
        start_calls = self.js("curvesSmoke.calls.length")
        row = {"name": name, "phase": self.phase, "passed": False, "expectedTrusted": expected}
        self.report["cases"].append(row)
        try:
            action()
            deadline = time.monotonic() + timeout
            while True:
                self.frame()
                state = self.snapshot()
                check(state["selectedPath"] == str(PHOTO) and state["canvasPath"] == str(PHOTO),
                      "Selected image/canvas left the dedicated fixture")
                check(not state["selectionChanges"], "Transient selection change observed")
                if self.mask_baseline is not None:
                    check(state["masks"] == self.mask_baseline, "Global operation changed fixture mask adjustments")
                if predicate(state):
                    break
                check(time.monotonic() < deadline, name + ": result predicate did not become true")
                time.sleep(0.05)
            events = self.js("[...curvesSmoke.events]")
            row.update({"state": state, "events": events, "details": self.extras,
                        "calls": self.js("curvesSmoke.calls.slice(" + str(start_calls) + ")")})
            for requirement in expected:
                check(any(e["trusted"] and e["caseName"] == name and
                          all(e.get(k) == value for k, value in requirement.items()) for e in events),
                      name + ": missing trusted input " + repr(requirement))
            check(all(e["trusted"] for e in events), name + ": synthetic input in measured case")
            row["passed"] = True
            return state
        except Exception:
            row["error"] = traceback.format_exc()
            row["details"] = self.extras
            try:
                row.update({"state": self.snapshot(), "events": self.js("[...curvesSmoke.events]"),
                            "calls": self.js("curvesSmoke.calls.slice(" + str(start_calls) + ")")})
            except Exception:
                row["observationError"] = traceback.format_exc()
            raise

    def header(self, which):
        self.click(PANEL + ' button[aria-label="' + which + '"]', "header-" + which.lower())

    def close(self):
        self.click(DIALOG + ' > button[aria-label="Close"]', "modal-close")

    def backdrop(self):
        return self.point("curvesSmoke.mark(curvesSmoke.one(" + json.dumps(DIALOG) +
                          ").parentElement,'backdrop')", "backdrop", 0.01, 0.01)

    def resize(self, width, height):
        # Change the real HWND. Measure the client delta, allowing native frame
        # size and DPI differences; never use Emulation.setDeviceMetricsOverride.
        samples = []
        win32gui.ShowWindow(self.hwnd, win32con.SW_RESTORE)
        for _ in range(8):
            before = self.js("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})")
            outer = win32gui.GetWindowRect(self.hwnd)
            client = win32gui.GetClientRect(self.hwnd)
            samples.append({"viewport": before, "outer": outer, "client": client})
            if before["width"] == width and before["height"] == height:
                break
            scale_x = (client[2] - client[0]) / before["width"]
            scale_y = (client[3] - client[1]) / before["height"]
            win32gui.SetWindowPos(self.hwnd, None, 40, 40,
                                 outer[2] - outer[0] + round((width - before["width"]) * scale_x),
                                 outer[3] - outer[1] + round((height - before["height"]) * scale_y),
                                 win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)
            time.sleep(0.25)
            self.frame()
        after = self.js("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})")
        self.extras["nativeResize"] = {"requested": [width, height], "samples": samples, "after": after,
                                       "clientAfter": win32gui.GetClientRect(self.hwnd),
                                       "outerAfter": win32gui.GetWindowRect(self.hwnd)}
        check((after["width"], after["height"]) == (width, height), "Native viewport resize failed")
        time.sleep(0.4)

    def mode(self, mode):
        self.click('[data-tab-id="layout-tab-' + mode + '"]', "tab-" + mode)
        wanted = {"crop": mode == "crop", "masks": mode == "masks", "ai": mode == "ai"}
        self.driver.wait_js(self.cdp, "JSON.stringify(curvesSmoke.snapshot().mode)===" + json.dumps(json.dumps(wanted, separators=(",", ":"))))
        entered = self.snapshot()
        check(entered["mode"] == wanted, "Real tool tab did not enter expected canvas mode")
        self.extras["enteredMode"] = entered

    def menu(self, label):
        self.click_expr("curvesSmoke.mark(curvesSmoke.header(),'curves-section')", "curves-section", "right", 0.12)
        self.driver.wait_js(self.cdp, "[...document.querySelectorAll('[role=menuitem]')].some(n=>n.innerText.trim()===" + json.dumps(label) + ")")
        self.extras["menuBeforeClick"] = self.snapshot()["menus"]
        self.click_expr("(() => {const n=[...document.querySelectorAll('[role=menuitem]')].filter(n=>curvesSmoke.visible(n)&&n.innerText.trim()===" +
                        json.dumps(label) + ");if(n.length!==1)throw Error('Ambiguous section menu');return n[0]})()", "section-menu-" + label)

    def estimate(self, watermark):
        calls = self.js("curvesSmoke.calls")
        matches = [c for c in calls if c["command"] == "estimate_export_sizes" and
                   c["caseName"] == self.js("curvesSmoke.caseName") and c["status"] == "fulfilled" and
                   isinstance(c.get("result"), (int, float)) and c["result"] > 0 and
                   c["args"].get("paths") == [str(PHOTO)] and
                   c["args"].get("currentEditPath") == str(PHOTO) and
                   (c["args"].get("exportSettings", {}).get("watermark") is not None) == watermark]
        if watermark:
            matches = [c for c in matches if c["args"]["exportSettings"]["watermark"]["path"] == str(WATERMARK)]
        return bool(matches)

    def toggle_watermark(self, enabled):
        self.click(DIALOG + ' label[for="switch-add-watermark"]', "watermark-switch-label")
        if enabled:
            # The actual effect must replace initial 16:9 / 1:1 preview props.
            self.driver.wait_js(self.cdp, """(() => {try {
              const {p}=curvesSmoke.watermarkPreview(),image=curvesSmoke.canvas().p.selectedImage;
              return image.width>0&&image.height>0&&Math.abs(p.imageAspectRatio-image.width/image.height)<1e-8&&
                p.watermarkImageAspectRatio===2;
            } catch {return false;}})()""", timeout=30)
            self.point("curvesSmoke.watermarkPreview().node", "watermark-preview")

    def verify_watermark_preview(self, state):
        geometry = self.js("curvesSmoke.watermarkGeometry()")
        self.extras["actualWatermarkPreview"] = geometry
        p, preview, wrapper, placeholder = (geometry[k] for k in ("props", "preview", "wrapper", "placeholder"))
        dims = state["imageDimensions"]
        check(dims["width"] > 0 and dims["height"] > 0, "RAW dimensions not available to the real preview")
        ratio = dims["width"] / dims["height"]

        def aspect(value):
            parts = value.split("/")
            return float(parts[0]) / (float(parts[1]) if len(parts) == 2 else 1)

        def near(a, b, tolerance=1.5):
            return abs(a - b) <= tolerance

        min_dimension_percent = 100 / ratio if ratio > 1 else 100
        width_percent = min_dimension_percent * 0.10
        spacing_percent = min_dimension_percent * 0.05
        actual = wrapper["rect"]
        checks = {
            "visible": geometry["visible"],
            "rawAspectProp": near(p["imageAspectRatio"], ratio, 1e-8),
            "watermarkAspectProp": p["watermarkImageAspectRatio"] == 2,
            "testParameters": p["watermarkPath"] == str(WATERMARK) and p["anchor"] == "bottomRight" and
                              p["scale"] == 10 and p["spacing"] == 5 and p["opacity"] == 75,
            "previewAspectStyle": near(aspect(preview["aspectRatio"]), ratio, 1e-5),
            "previewAspectRect": near(preview["rect"]["width"], preview["rect"]["height"] * ratio),
            "watermarkAspectStyle": near(aspect(placeholder["aspectRatio"]), 2, 1e-8),
            "watermarkAspectRect": near(placeholder["rect"]["width"], placeholder["rect"]["height"] * 2),
            "widthStyle": near(float(wrapper["width"].removesuffix("%")), width_percent, 1e-5),
            "rightStyle": near(float(wrapper["right"].removesuffix("%")), spacing_percent, 1e-5),
            "bottomStyle": near(float(wrapper["bottom"].removesuffix("%")), spacing_percent, 1e-5),
            "positionStyle": wrapper["position"] == "absolute",
            "opacityStyle": near(float(wrapper["opacity"]), 0.75, 1e-8),
            "widthRect": near(actual["width"], preview["clientWidth"] * width_percent / 100),
            "placeholderWidth": near(placeholder["rect"]["width"], actual["width"]),
            "rightRect": near(preview["rect"]["right"] - preview["borderRight"] - actual["right"],
                              preview["clientWidth"] * spacing_percent / 100),
            "bottomRect": near(preview["rect"]["bottom"] - preview["borderBottom"] - actual["bottom"],
                               preview["clientHeight"] * spacing_percent / 100),
        }
        self.extras["watermarkPreviewAssertions"] = checks
        check(all(checks.values()), "Real WatermarkPreview props/DOM geometry mismatch: " + json.dumps(checks))
        return True


def input_requirement(kind, role=None, code=None):
    result = {"type": kind}
    if role is not None:
        result["role"] = role
    if code is not None:
        result["code"] = code
    return result


def standalone(state):
    graphs = [g for g in state["graphs"] if not g["mask"] and g["visible"]]
    return (state["layoutMode"] == "full" and len(graphs) == 1 and graphs[0]["region"] == "leftTop" and
            {"panel": "curves", "region": "leftTop"} in state["panels"])


def modal(state, label):
    return (len(state["dialogs"]) == 1 and state["dialogs"][0]["label"] == label and
            (label != "Metadata" or PHOTO.name in state["dialogs"][0]["text"]))


def default_curves(curves):
    return curves is not None and all(points == [{"x": 0, "y": 0}, {"x": 255, "y": 255}]
                                      for points in curves.values()) and len(curves) == 4


def keyboard_defaults():
    candidates = [ROOT / "keyboardUtils.ts", BASE / "app/src/utils/keyboardUtils.ts"]
    source = next((p for p in candidates if p.is_file()), None)
    check(source is not None, "Parent must provide keyboardUtils.ts at ROOT or in BASE/app/src/utils")
    text = source.read_text(encoding="utf-8-sig")
    combos = {}
    for action in ("toggle_metadata", "toggle_export", "toggle_left_panel", "toggle_adjustments"):
        match = re.search(r"action:\s*'" + action + r"'\s*,[\s\S]*?defaultCombo:\s*\[([^]]*)\]", text)
        check(match is not None, "Cannot read default keybind: " + action)
        combos[action] = re.findall(r"'([^']+)'", match.group(1))
        check(bool(combos[action]), "Empty default keybind: " + action)
    return {"path": str(source), "sha256": sha(source), "combos": combos}


def watermark_png():
    # Real 32x16 opaque RGBA test asset; no external download or personal files.
    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    pixels = b"".join(b"\0" + b"".join(bytes((255, 64 if x < 16 else 220, 32, 255))
                                      for x in range(32)) for _ in range(16))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", 32, 16, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def seed_settings():
    # Start from defaults, not a user's integrations, destination or shortcuts.
    return {"language": "en", "decorations": False, "keybinds": {},
            "enableXmpSync": False, "createXmpIfMissing": False,
            "rootFolders": [str(PHOTO.parent)], "lastRootPath": str(PHOTO.parent),
            "grouping": "off", "libraryViewMode": "recursive",
            "uiVisibility": {"leftPanel": True, "rightPanel": True, "filmstrip": True, "quickFilter": False},
            "lastFolderState": {"currentFolderPath": str(PHOTO.parent), "expandedFolders": [str(PHOTO.parent)],
                                "activeAlbumId": None, "expandedAlbumGroups": []},
            "adjustmentLayout": {"openSections": {"basic": True, "curves": True, "color": False,
                                                  "details": False, "effects": False}},
            "workspace": {"leftPanelWidth": 350, "rightPanelWidth": 350, "leftTopHeight": 450, "rightTopHeight": 450,
                          "panelLayout": {"leftTop": ["metadata", "folderTree", "export", "tethering"], "leftBottom": [],
                                          "rightTop": ["adjustments", "crop", "masks", "ai", "presets"], "rightBottom": []},
                          "activePanels": {"leftTop": "folderTree", "leftBottom": None,
                                           "rightTop": "adjustments", "rightBottom": None},
                          "panelSwitcherPlacement": {"leftTop": "bottom", "leftBottom": "bottom",
                                                     "rightTop": "right", "rightBottom": "right"}},
            "exportPresets": [{"id": "__last_used__", "name": "__last_used__", "fileFormat": "jpeg",
                               "jpegQuality": 90, "tiffBitDepth": 16, "dpi": 96,
                               "enableResize": False, "resizeMode": "longEdge", "resizeValue": 2048, "dontEnlarge": True,
                               "enablePad": False, "enableBorder": False, "keepMetadata": True,
                               "preserveTimestamps": False, "stripGps": True, "preserveFolders": False, "exportMasks": False,
                               "filenameTemplate": "{original_filename}_curves-smoke", "enableWatermark": True,
                               "watermarkPath": str(WATERMARK), "watermarkAnchor": "bottomRight",
                               "watermarkScale": 10, "watermarkSpacing": 5, "watermarkOpacity": 75,
                               "destinationType": "originalFolder", "subfolder": "output"}]}


def owned_hwnd(process):
    handles = []
    win32gui.EnumWindows(lambda h, _: handles.append(h) if win32process.GetWindowThreadProcessId(h)[1] == process.pid
                         and win32gui.IsWindowVisible(h) and win32gui.GetWindowText(h) == TITLE else None, None)
    check(len(handles) == 1, "Expected exactly one owned TBT HWND")
    return handles[0]


def stop_owned(process, hwnd):
    if process is None or process.poll() is not None:
        return
    if hwnd is not None and win32gui.IsWindow(hwnd) and win32process.GetWindowThreadProcessId(hwnd)[1] == process.pid:
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=20)
    check(process.poll() is not None, "Owned process still running")


def install_observers(s):
    s.driver.wait_js(s.cdp, "[...document.querySelectorAll('button')].some(n=>/Continue Session/i.test(n.innerText))")
    s.js((ROOT / "observe.js").read_text(encoding="utf-8"))
    s.js(OBSERVER_JS)
    verified = s.js("curvesSmoke.probeHook()")
    check(verified["installed"] and verified["verified"] and verified["readOnlyInternalsUnchanged"] and
          not verified["errors"], "Real native IPC fetch observer probe failed")
    s.report.setdefault("observerHooks", {})[s.phase] = verified
    s.js("curvesSmoke.listen()")


def navigate_setup(s):
    s.report["setup"].append({"kind": "synthetic-library-navigation", "phase": s.phase,
                              "reason": "Setup only, excluded from measured trusted cases"})
    s.js("[...document.querySelectorAll('button')].find(n=>/Continue Session/i.test(n.innerText)).click()")
    s.driver.wait_js(s.cdp, "baseline.thumbnailCoverage().expected===1&&baseline.thumbnailCoverage().missing===0", timeout=120)
    s.js("document.querySelector('[data-bench-id=thumbnail]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
    s.driver.wait_js(s.cdp, "baseline.filmstrip()?.selectedImage?.isReady", timeout=120)
    s.driver.wait_js(s.cdp, "!!document.querySelector('[data-panel=curves]')", timeout=30)
    time.sleep(0.5)


def arm_selection(s):
    s.js("curvesSmoke.events.length=0;curvesSmoke.expectedPath=" + json.dumps(str(PHOTO)) + ";curvesSmoke.armed=true")


def sidebar_widths(state, left, right):
    return all(any(p["side"] == side and p["visible"] and abs(p["width"] - width) < 0.5 and
                   abs(float(p["cssWidth"].removesuffix("px")) - width) < 0.5 and p["propWidth"] == width
                   for p in state["sidebars"]) for side, width in (("left", left), ("right", right)))


def compact_curves(state):
    graphs = [g for g in state["graphs"] if not g["mask"] and g["visible"]]
    return (state["layoutMode"] == "compact" and state["compactActivePanel"] == "adjustments" and
            not state["panels"] and not state["dialogs"] and len(graphs) == 1 and graphs[0]["region"] == "compact")


def reveal_existing_curve(s, region):
    expression = "curvesSmoke.graphs().find(g=>!g.mask&&g.region===" + json.dumps(region) + ")"
    s.driver.wait_js(s.cdp, "!!(" + expression + ")")
    s.js("(" + expression + ").node.scrollIntoView({block:'center'})")
    s.frame()
    s.extras.setdefault("navigation", []).append({"kind": "programmatic-scroll", "region": region,
        "reason": "Reveal the existing curve section below Basic; not a trusted wheel test"})


def run_cases(s):
    click = input_requirement
    s.record("migrated-desktop-initial", lambda: s.click('[data-tab-id="layout-tab-curves"]', "tab-curves"),
             lambda r: standalone(r) and r["mode"] == {"crop": False, "masks": False, "ai": False} and
             not r["dialogs"] and not any(g["region"].startswith("right") and not g["mask"] for g in r["graphs"]),
             [click("click", "tab-curves")])
    for name, label in (("Info", "Metadata"), ("Export", "Export")):
        s.record("header-" + name.lower(), lambda name=name: s.header(name),
                 lambda r, label=label: standalone(r) and modal(r, label), [click("click", "header-" + name.lower())])
        s.record("close-button-" + name.lower(), s.close, lambda r: not r["dialogs"] and standalone(r), [click("click", "modal-close")])
        action = "toggle_metadata" if name == "Info" else "toggle_export"
        code = s.report["keyboardDefaults"]["combos"][action][-1]
        s.record("shortcut-" + name.lower(), lambda action=action: s.shortcut(action),
                 lambda r, label=label: modal(r, label) and standalone(r), [click("keydown", code=code), click("keyup", code=code)])
        s.record("escape-" + name.lower(), lambda: s.key("Escape"), lambda r: not r["dialogs"] and standalone(r),
                 [click("keydown", code="Escape"), click("keyup", code="Escape")])

        def drag_out(name=name):
            s.header(name)
            inside = s.point("curvesSmoke.one(" + json.dumps(DIALOG) + ")", "modal-inside", 0.3, 0.05)
            outside = s.backdrop()
            s.mouse("mousePressed", inside)
            s.mouse("mouseMoved", outside, "left", 1)
            s.mouse("mouseReleased", outside)
            time.sleep(0.2)

        s.record("inside-drag-release-outside-" + name.lower(), drag_out,
                 lambda r, label=label: modal(r, label),
                 [click("pointerdown", "modal-inside"), click("pointerup", "backdrop")])

        def backdrop_click():
            point = s.backdrop()
            s.mouse("mousePressed", point)
            s.mouse("mouseReleased", point)

        s.record("backdrop-dismiss-" + name.lower(), backdrop_click, lambda r: not r["dialogs"] and standalone(r),
                 [click("pointerdown", "backdrop"), click("pointerup", "backdrop")])

    def canvas_export():
        s.click_expr("curvesSmoke.mark(curvesSmoke.canvas().node,'image-canvas')", "image-canvas", "right")
        s.driver.wait_js(s.cdp, "[...document.querySelectorAll('[role=menuitem]')].some(n=>n.innerText.trim()==='Export Image')")
        s.extras["canvasMenu"] = s.snapshot()["menus"]
        s.click_expr("[...document.querySelectorAll('[role=menuitem]')].find(n=>n.innerText.trim()==='Export Image')", "canvas-export-menu")

    s.record("canvas-context-export", canvas_export, lambda r: modal(r, "Export") and standalone(r),
             [click("contextmenu", "image-canvas"), click("click", "canvas-export-menu")])
    s.record("canvas-export-close", s.close, lambda r: not r["dialogs"], [click("click", "modal-close")])

    for mode, x, y in (("crop", 0.30, 0.25), ("masks", 0.50, 0.28), ("ai", 0.70, 0.40)):
        before = s.snapshot()["curves"]

        def edit(mode=mode, x=x, y=y):
            s.mode(mode)
            s.click_expr("curvesSmoke.globalGraph()", "curve-global", fx=x, fy=y)

        wanted = {"crop": mode == "crop", "masks": mode == "masks", "ai": mode == "ai"}
        s.record("global-curves-retain-" + mode, edit,
                 lambda r, before=before, wanted=wanted: r["mode"] == wanted and r["curves"] != before and standalone(r),
                 [click("click", "tab-" + mode), click("mousedown", "curve-global"), click("mouseup", "curve-global")])
    s.record("return-adjustments-tab", lambda: s.click('[data-tab-id="layout-tab-adjustments"]', "tab-adjustments"),
             lambda r: r["mode"] == {"crop": False, "masks": False, "ai": False} and standalone(r),
             [click("click", "tab-adjustments")])

    copied = copy.deepcopy(s.snapshot()["curves"])
    for command in ("Copy", "Reset", "Paste"):
        label = command + " Curves Settings"
        predicate = (lambda r: default_curves(r["curves"]) and r["curveMode"] == "point") if command == "Reset" else (lambda r: r["curves"] == copied)
        s.record("section-" + command.lower(), lambda label=label: s.menu(label), predicate,
                 [click("contextmenu", "curves-section"), click("click", "section-menu-" + label)])
    for enabled, label in ((False, "Disable Section"), (True, "Enable Section")):
        s.record("global-curves-" + ("show" if enabled else "hide"),
                 lambda label=label: s.click(PANEL + ' button[data-tooltip="' + label + '"]', "curve-visibility"),
                 lambda r, enabled=enabled: r["curveEnabled"] is enabled and r["curves"] == copied and standalone(r),
                 [click("click", "curve-visibility")])

    collapse_code = s.report["keyboardDefaults"]["combos"]["toggle_left_panel"][-1]
    def collapse_left():
        s.shortcut("toggle_left_panel")
        reveal_existing_curve(s, "rightTop")

    s.record("collapse-left-right-fallback", collapse_left,
             lambda r: not any(p["region"].startswith("left") for p in r["panels"]) and
             len([g for g in r["graphs"] if not g["mask"] and g["visible"] and g["region"].startswith("right")]) == 1,
             [click("keydown", code=collapse_code), click("keyup", code=collapse_code)])
    s.record("reopen-left-removes-duplicate", lambda: s.shortcut("toggle_left_panel"),
             lambda r: standalone(r) and not any(g["region"].startswith("right") and not g["mask"] for g in r["graphs"]),
             [click("keydown", code=collapse_code), click("keyup", code=collapse_code)])

    def small_full():
        s.resize(800, 600)
        s.shortcut("toggle_metadata")

    meta_code = s.report["keyboardDefaults"]["combos"]["toggle_metadata"][-1]
    s.record("native-800x600-full-modal", small_full,
             lambda r: (r["viewport"]["width"], r["viewport"]["height"]) == (800, 600) and standalone(r) and modal(r, "Metadata"),
             [click("keydown", code=meta_code), click("keyup", code=meta_code)])
    s.record("small-full-close", s.close, lambda r: not r["dialogs"], [click("click", "modal-close")])

    def compact():
        s.resize(600, 800)
        s.click_expr("curvesSmoke.mobileTab('adjustments')", "mobile-adjustments")
        reveal_existing_curve(s, "compact")

    s.record("native-600x800-compact-curves", compact,
             lambda r: compact_curves(r) and (r["viewport"]["width"], r["viewport"]["height"]) == (600, 800),
             [click("click", "mobile-adjustments")])
    for panel, label in (("metadata", "Metadata"), ("export", "Export")):
        s.record("compact-legacy-" + panel, lambda panel=panel: s.click_expr("curvesSmoke.mobileTab('" + panel + "')", "mobile-" + panel),
                 lambda r, panel=panel: r["layoutMode"] == "compact" and r["compactActivePanel"] == panel and not r["dialogs"] and
                 (r["exportState"] is not None if panel == "export" else s.js("document.body.innerText.includes('Metadata')")),
                 [click("click", "mobile-" + panel)])
    def compact_adjustments():
        s.click_expr("curvesSmoke.mobileTab('adjustments')", "mobile-adjustments")
        reveal_existing_curve(s, "compact")

    s.record("compact-return-adjustments", compact_adjustments,
             compact_curves,
             [click("click", "mobile-adjustments")])

    def restore_full():
        s.resize(1280, 720)
        check(standalone(s.snapshot()), "Full layout did not restore standalone Curves before further input")
        s.shortcut("toggle_metadata")

    s.record("native-full-restore", restore_full, lambda r: standalone(r) and modal(r, "Metadata") and
             (r["viewport"]["width"], r["viewport"]["height"]) == (1280, 720),
             [click("keydown", code=meta_code), click("keyup", code=meta_code)])
    s.record("full-restore-close", s.close, lambda r: not r["dialogs"], [click("click", "modal-close")])

    s.record("real-watermark-size-estimate", lambda: s.header("Export"),
             lambda r: modal(r, "Export") and s.estimate(True) and s.js("curvesSmoke.calls.some(c=>c.command==='get_image_dimensions'&&c.args.path===" +
                 json.dumps(str(WATERMARK)) + "&&c.status==='fulfilled'&&c.result.width===32&&c.result.height===16)"),
             [click("click", "header-export")], timeout=120)
    for enabled in (False, True):
        s.record("real-watermark-estimate-" + ("on-preview" if enabled else "off"),
                 lambda enabled=enabled: s.toggle_watermark(enabled),
                 lambda r, enabled=enabled: modal(r, "Export") and s.estimate(enabled) and
                 s.js("document.getElementById('switch-add-watermark').checked") is enabled and
                 (s.verify_watermark_preview(r) if enabled else True),
                 [click("click", "watermark-switch-label")], timeout=120)

    def start_export():
        check(not EXPORT_DIR.exists(), "Refuse existing export output")
        # Verify the actual successful estimate's settings before pressing Export.
        calls = s.js("curvesSmoke.calls.filter(c=>c.command==='estimate_export_sizes'&&c.status==='fulfilled')")
        settings = calls[-1]["args"]["exportSettings"]
        check(settings["destinationType"] == "originalFolder" and settings["subfolder"] == "output" and
              settings["filenameTemplate"] == "{original_filename}_curves-smoke" and not settings["exportMasks"] and
              settings["watermark"]["path"] == str(WATERMARK), "Unsafe or unexpected real export settings")
        s.extras["verifiedExportSettings"] = settings
        s.click_expr("(() => {const d=curvesSmoke.one(" + json.dumps(DIALOG) + ");const n=[...d.querySelectorAll('button')].filter(n=>n.innerText.trim()==='Export Image');if(n.length!==1)throw Error('Missing/ambiguous real Export Image button');return n[0]})()", "export-submit")

    s.record("real-export-start", start_export, lambda r: modal(r, "Export") and
             s.js("curvesSmoke.calls.some(c=>c.command==='export_images')"), [click("click", "export-submit")])

    def close_export():
        s.extras["beforeClose"] = s.snapshot()["exportState"]
        s.extras["completedBeforeClose"] = s.js("curvesSmoke.nativeEvents.some(e=>e.event==='export-complete')")
        in_flight = s.extras["beforeClose"]["status"] == "exporting" and not s.extras["completedBeforeClose"]
        s.report["exportFlow"] = {"inFlightAtClose": in_flight, "inFlightAtReopen": False}
        s.close()
        s.extras["closedAt"] = s.js("performance.now()")
        if not in_flight:
            s.report["pendingParentChecks"].append("Single RAW completed before modal close: in-flight continuation/progress requires a slower real export.")

    s.record("real-export-close", close_export, lambda r: not r["dialogs"], [click("click", "modal-close")])
    export_code = s.report["keyboardDefaults"]["combos"]["toggle_export"][-1]

    def reopen_export():
        s.shortcut("toggle_export")
        s.driver.wait_js(s.cdp, "!!curvesSmoke.snapshot().exportState")
        reopened = s.snapshot()["exportState"]
        s.extras["immediateReopenedExportState"] = reopened
        check(reopened["status"] != "error", "Real export failed: " + json.dumps(reopened))
        s.report["exportFlow"]["inFlightAtReopen"] = reopened["status"] == "exporting"
        if reopened["status"] != "exporting":
            s.report["pendingParentChecks"].append("Reopened modal did not show an in-flight job; real in-flight reopen/progress remains unmeasured (no timing mock).")
        else:
            check(reopened["progress"]["total"] == 1, "Reopened progress did not preserve the real one-image job")

    s.record("real-export-reopen-and-complete", reopen_export,
             lambda r: modal(r, "Export") and s.js("curvesSmoke.nativeEvents.some(e=>e.event==='export-complete')") and
             not s.js("curvesSmoke.nativeEvents.some(e=>e.event==='export-error')") and EXPORTED.is_file(),
             [click("keydown", code=export_code), click("keyup", code=export_code)], timeout=240)
    from PIL import Image
    with Image.open(EXPORTED) as image:
        dimensions = image.size
        check(image.format == "JPEG" and min(dimensions) > 0, "Export is not a real JPEG")
        image.verify()
    check(sorted(p.name for p in EXPORT_DIR.iterdir()) == [EXPORTED.name], "Unexpected files in isolated export output")
    exported_calls = s.js("curvesSmoke.calls.filter(c=>c.command==='export_images')")
    check(len(exported_calls) == 1 and exported_calls[0]["status"] == "fulfilled", "Real export invoke did not complete exactly once")
    args = exported_calls[0]["args"]
    check(args["paths"] == [str(PHOTO)] and args["currentEditPath"] == str(PHOTO) and
          args["baseOriginFolders"] == [str(PHOTO.parent)] and not args["isExplicitFilePath"] and
          args["exportSettings"]["destinationType"] == "originalFolder" and
          args["exportSettings"]["subfolder"] == "output" and
          args["exportSettings"]["watermark"]["path"] == str(WATERMARK), "Actual export arguments diverged from the isolated test setup")
    s.report["realExport"] = {"path": str(EXPORTED), "bytes": EXPORTED.stat().st_size,
                              "sha256": sha(EXPORTED), "dimensions": dimensions,
                              "watermarkVerification": "Real preview props/DOM geometry, dimensions/estimate/export parameters verified; rendered JPEG watermark pixels not compared."}
    s.record("real-export-final-close", s.close, lambda r: not r["dialogs"] and standalone(r), [click("click", "modal-close")])


def main():
    global win32gui, win32con, win32process
    check(os.name == "nt", "Run only in the parent's interactive Windows session; static checks may compile this file")
    import win32con
    import win32gui
    import win32process

    check(not OUTPUT.exists() and not EXPORT_DIR.exists() and not WATERMARK.exists(), "Refuse to overwrite smoke evidence/assets/output")
    existing = []
    win32gui.EnumWindows(lambda h, _: existing.append(h) if win32gui.GetWindowText(h) == TITLE else None, None)
    check(not existing, "Close all existing RapidRAW TBT windows before using this fork's profile")
    fixture_paths = [p for p in (OUT / "fixture.json", ROOT / "fixture.json") if p.is_file()]
    check(len(fixture_paths) == 1, "Parent must supply exactly one fixture.json at ROOT or evidence")
    fixture = json.loads(fixture_paths[0].read_text(encoding="utf-8-sig"))
    expected_sha = fixture.get("sha256", fixture.get("sha"))
    check(isinstance(expected_sha, str) and re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha), "Missing fixture SHA256")
    expected_sha = expected_sha.lower()
    check(expected_sha == NASA_SHA256, "fixture.json does not identify the authorized NASA source bytes")
    check(Path(fixture["path"]).resolve() == PHOTO.resolve(), "fixture.json path is not the dedicated curves RAW")
    check(bool(fixture.get("sourceRel")), "fixture.json must identify the NASA sourceRel")
    check(PHOTO.is_file() and not PHOTO.is_symlink() and sha(PHOTO) == expected_sha, "Original fixture hash/path mismatch")
    # A fresh fixture avoids reading any unrelated library image or old sidecar.
    check(list(PHOTO.parent.iterdir()) == [PHOTO], "Fixture directory must initially contain only photo-000.NEF")
    keyboard = keyboard_defaults()
    hashes = {"scriptSha256": sha(Path(__file__)), "driverSha256": sha(ROOT / "windows-cdp.py"),
              "observerSha256": sha(ROOT / "observe.js"), "exeSha256": sha(EXE)}
    config = Path(os.environ["APPDATA"]) / "io.github.tursom.RapidRAW"
    files = [config / "settings.json", config / "window_state.json"]
    original = {p: p.read_bytes() if p.exists() else None for p in files}
    report = {"schema": "rapidraw-curves-panel-windows-smoke-v1", "started": stamp(), "passed": False,
              **hashes, "fixture": fixture, "fixtureSha256Before": expected_sha, "keyboardDefaults": keyboard,
              "preflight": {"noExistingTbtWindow": True, "freshOutput": True, "dedicatedFixture": True},
              "profileBefore": [{"file": p.name, "existed": data is not None,
                                 "sha256": hashlib.sha256(data).hexdigest() if data is not None else None}
                                for p, data in original.items()],
              "setup": [], "cases": [], "pendingParentChecks": [], "limits": [
                  "Rendered JPEG watermark pixel comparison is not automated; real preview geometry, native parameters/dimensions and actual JPEG are checked."]}
    OUT.mkdir(parents=True, exist_ok=True)
    # Exclusive creation is also a concurrent-controller lock. Never truncate evidence.
    evidence = OUTPUT.open("x", encoding="utf-8")
    process = cdp = smoke = None
    measured_ok = False
    try:
        spec = importlib.util.spec_from_file_location("curves_windows_driver", ROOT / "windows-cdp.py")
        driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(driver)
        driver.ROOT, driver.OUT, driver.EXE = ROOT, OUT, EXE
        (ROOT / "logs").mkdir(exist_ok=True)
        with WATERMARK.open("xb") as stream:
            stream.write(watermark_png())
        report["watermarkAsset"] = {"path": str(WATERMARK), "sha256": sha(WATERMARK), "dimensions": [32, 16]}
        config.mkdir(parents=True, exist_ok=True)
        # Independent real startup with workspace ABSENT: Rust must supply its
        # desktop defaults before the frontend reconciles panel migration.
        fresh_settings = seed_settings()
        del fresh_settings["workspace"]
        files[0].write_text(json.dumps(fresh_settings), encoding="utf-8")
        process, cdp, fresh_timing = driver.launch()
        smoke = Smoke(cdp, driver, process, report, owned_hwnd(process), phase="new-install")
        report["newInstall"] = {"workspaceAbsentInSeed": True, "launch": fresh_timing,
                                "browser": cdp.call("Browser.getVersion")}
        fresh_effective = smoke.invoke_setup("load_settings")
        check(fresh_effective["rootFolders"] == [str(PHOTO.parent)], "New-install startup loaded an unrelated root")
        fresh_workspace = fresh_effective["workspace"]
        report["newInstall"]["nativeWorkspace"] = fresh_workspace
        expected_dimensions = {"leftPanelWidth": 250, "rightPanelWidth": 320, "leftTopHeight": 340, "rightTopHeight": 450}
        check(all(fresh_workspace[k] == v for k, v in expected_dimensions.items()), "Native new-install desktop workspace defaults incorrect")
        install_observers(smoke)
        navigate_setup(smoke)
        report["newInstall"]["stateBeforeInput"] = smoke.snapshot()
        check(standalone(report["newInstall"]["stateBeforeInput"]), "New-install Curves did not activate before input")
        arm_selection(smoke)
        smoke.record("new-install-native-and-css-defaults",
                     lambda: smoke.click('[data-tab-id="layout-tab-curves"]', "tab-curves"),
                     lambda r: standalone(r) and sidebar_widths(r, 250, 320),
                     [input_requirement("click", "tab-curves")])
        report["newInstall"]["selectionChanges"] = cdp.js("curvesSmoke.selectionChanges")
        cdp.close()
        cdp = None
        stop_owned(process, smoke.hwnd)
        report["newInstall"]["processStopped"] = process.poll() is not None
        process = smoke = None
        for path, data in original.items():
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(data)
        report["newInstall"]["profileRestored"] = all((p.read_bytes() if p.exists() else None) == data for p, data in original.items())
        report["newInstall"]["fixtureSha256After"] = sha(PHOTO)
        check(report["newInstall"]["processStopped"] and report["newInstall"]["profileRestored"] and
              report["newInstall"]["fixtureSha256After"] == expected_sha and not report["newInstall"]["selectionChanges"],
              "New-install phase failed shutdown/profile restoration/RAW verification")
        existing_after_fresh = []
        win32gui.EnumWindows(lambda h, _: existing_after_fresh.append(h) if win32gui.GetWindowText(h) == TITLE else None, None)
        check(not existing_after_fresh, "An existing TBT window prevents the independent migration launch")

        # Second independent startup: complete OLD user layout, preserving its
        # 350/350/450/450 dimensions rather than replacing them with defaults.
        settings = seed_settings()
        report["seedWorkspace"] = settings["workspace"]
        files[0].write_text(json.dumps(settings), encoding="utf-8")
        # driver.launch resets only the fork window_state; both files are backed up above.
        process, cdp, timing = driver.launch()
        report["launch"] = timing
        report["browser"] = cdp.call("Browser.getVersion")
        smoke = Smoke(cdp, driver, process, report, owned_hwnd(process))
        effective = smoke.invoke_setup("load_settings")
        check(effective["rootFolders"] == [str(PHOTO.parent)], "Dedicated fixture root not loaded")
        tethering = smoke.invoke_setup("is_tethering_supported")
        check(isinstance(tethering, bool), "Native tethering support response is not boolean")
        report["tetheringSupported"] = tethering
        install_observers(smoke)
        # Setup only: seed a nonempty sentinel mask via the REAL backend, before
        # editor navigation. The frontend normalizes missing mask defaults.
        mask = {"id": "curves-smoke-sentinel", "name": "Curves smoke sentinel", "opacity": 100,
                "visible": True, "invert": False, "subMasks": [],
                "adjustments": {"curveMode": "point", "curves": {
                    channel: [{"x": 0, "y": 11 if channel == "luma" else 0}, {"x": 255, "y": 231 if channel == "luma" else 255}]
                    for channel in ("luma", "red", "green", "blue")}}}
        smoke.invoke_setup("apply_adjustments_to_paths", {"paths": [str(PHOTO)], "adjustments": {"masks": [mask]}})
        seeded = smoke.invoke_setup("load_metadata", {"path": str(PHOTO)})
        check(seeded["adjustments"]["masks"][0]["id"] == mask["id"], "Native sentinel mask setup failed")
        navigate_setup(smoke)
        before = smoke.snapshot()
        check(standalone(before), "Migration failed to activate standalone left Curves before measured input")
        check(sidebar_widths(before, 350, 350), "Migration changed the old user's actual CSS sidebar widths")
        check(before["selectedPath"] == str(PHOTO), "Setup selected wrong RAW")
        check(before["masks"] and before["masks"][0]["id"] == mask["id"] and
              before["masks"][0]["adjustments"]["curves"] == mask["adjustments"]["curves"], "Nonempty mask sentinel not loaded")
        smoke.mask_baseline = copy.deepcopy(before["masks"])
        report["initialStateBeforeInput"] = before
        # Read native dimensions and the reconciled frontend workspace separately.
        # Initial reconciliation need not have reached asynchronous persistence.
        native_workspace = smoke.invoke_setup("load_settings")["workspace"]
        report["nativeMigrationWorkspace"] = native_workspace
        for dimension in ("leftPanelWidth", "rightPanelWidth", "leftTopHeight", "rightTopHeight"):
            check(native_workspace[dimension] == settings["workspace"][dimension], "Native load_settings lost user dimension: " + dimension)
        arm_selection(smoke)
        workspace_state = smoke.record("migration-actual-workspace", lambda: smoke.header("Export"),
                                       lambda r: modal(r, "Export") and standalone(r) and r["exportWorkspace"] is not None,
                                       [input_requirement("click", "header-export")])
        migrated = workspace_state["exportWorkspace"]
        flattened = [p for panels in migrated["panelLayout"].values() for p in panels]
        expected_panels = {"curves", "metadata", "folderTree", "export", "adjustments", "crop", "masks", "ai", "presets"}
        check(set(flattened) == expected_panels | ({"tethering"} if tethering else set()) and
              len(flattened) == len(set(flattened)), "Migration lost/duplicated a legacy panel or ignored native tethering support")
        expected_layout = copy.deepcopy(settings["workspace"]["panelLayout"])
        expected_layout["leftTop"] = ["curves"] + [p for p in expected_layout["leftTop"] if p != "tethering" or tethering]
        expected_active = {**settings["workspace"]["activePanels"], "leftTop": "curves"}
        check(migrated["panelLayout"] == expected_layout and migrated["activePanels"] == expected_active,
              "Migration changed legacy panel order/regions/active tools beyond adding and activating Curves")
        check(migrated["panelSwitcherPlacement"] == settings["workspace"]["panelSwitcherPlacement"], "Switcher placement lost in migration")
        for dimension in ("leftPanelWidth", "rightPanelWidth", "leftTopHeight", "rightTopHeight"):
            check(migrated[dimension] == settings["workspace"][dimension], "Migration overwrote old user dimension: " + dimension)
        report["migratedWorkspace"] = migrated
        smoke.record("migration-workspace-close", smoke.close, lambda r: not r["dialogs"] and standalone(r),
                     [input_requirement("click", "modal-close")])
        run_cases(smoke)
        check(report["cases"] and all(row["passed"] for row in report["cases"]), "Incomplete case suite")
        measured_ok = True
    except Exception:
        report["error"] = traceback.format_exc()
    finally:
        cleanup_errors = []
        if cdp is not None:
            try:
                report["nativeCalls"] = cdp.js("curvesSmoke.calls")
                report["nativeEvents"] = cdp.js("curvesSmoke.nativeEvents")
                report["selectionChanges"] = cdp.js("curvesSmoke.selectionChanges")
                report["finalObserverHook"] = cdp.js("curvesSmoke.hookStatus()")
                check(report["finalObserverHook"]["installed"] and report["finalObserverHook"]["verified"] and
                      report["finalObserverHook"]["readOnlyInternalsUnchanged"] and not report["finalObserverHook"]["errors"],
                      "Final IPC fetch observer integrity check failed")
            except Exception:
                report["finalObservationError"] = traceback.format_exc()
                measured_ok = False
            try:
                cdp.close()
            except Exception as error:
                cleanup_errors.append("CDP close: " + str(error))
        # Stop the owned process before restoration, including when observation
        # or graceful shutdown fails. Never close an unowned desktop window.
        if process is not None:
            try:
                stop_owned(process, smoke.hwnd if smoke is not None else None)
            except Exception:
                cleanup_errors.append("Owned process shutdown: " + traceback.format_exc())
        report["processStopped"] = process is None or process.poll() is not None
        for path, data in original.items():
            try:
                if data is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(data)
            except Exception:
                cleanup_errors.append("Restore " + path.name + ": " + traceback.format_exc())
        try:
            report["profileRestored"] = all((p.read_bytes() if p.exists() else None) == data for p, data in original.items())
        except Exception:
            report["profileRestored"] = False
            cleanup_errors.append("Profile readback: " + traceback.format_exc())
        try:
            report["fixtureSha256After"] = sha(PHOTO)
        except Exception:
            report["fixtureSha256After"] = None
            cleanup_errors.append("Fixture readback: " + traceback.format_exc())
        report["rawBytesUnchanged"] = report["fixtureSha256After"] == expected_sha
        report["cleanupErrors"] = cleanup_errors
        fresh = report.get("newInstall", {})
        fresh_ok = fresh.get("processStopped") and fresh.get("profileRestored") and fresh.get("fixtureSha256After") == expected_sha
        report["passed"] = bool(measured_ok and report["profileRestored"] and report["rawBytesUnchanged"] and
                                fresh_ok and report["processStopped"] and not cleanup_errors and not report.get("selectionChanges"))
        report["coverageComplete"] = report["passed"] and not report["pendingParentChecks"]
        report["finished"] = stamp()
        try:
            json.dump(report, evidence, indent=2, ensure_ascii=False)
            evidence.write("\n")
            evidence.flush()
            os.fsync(evidence.fileno())
        finally:
            evidence.close()
    print(json.dumps({"passed": report["passed"], "coverageComplete": report["coverageComplete"],
                      "cases": len(report["cases"]), "evidence": str(OUTPUT),
                      "pendingParentChecks": report["pendingParentChecks"]}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
