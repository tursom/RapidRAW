"""Task1 release measurements; run in the logged-in Windows Interactive session.

Usage: python windows-measure.py [--presets20]
An existing report is never overwritten. Move prior attempts within the Windows
workspace before rerunning; only complete v3 evidence is eligible for analysis.
"""

import importlib.util
import json
from pathlib import Path
import sys
import time
import traceback

spec = importlib.util.spec_from_file_location("cdp_driver", Path(__file__).with_name("windows-cdp.py"))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
ROOT, OUT = driver.ROOT, driver.OUT
FIXTURE = ROOT / "fixtures"
PRESETS20 = "--presets20" in sys.argv
REPORT_FILE = OUT / ("presets20.json" if PRESETS20 else "measurements.json")
REPORT = {
    "schema": "rapidraw-task1-baseline", "measurementVersion": 3,
    "method": "Unmodified release; WebView2 CDP; page performance.now/rAF; startup polled every 20ms",
    "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "startup": [], "switches": [],
    "sourceIO": {"status": "unknown", "traced": False},
    "backendCache": {"status": "unknown", "note": "Repeated selection is not evidence of a backend cache hit; preloader remains enabled"},
    "condition": "presets20" if PRESETS20 else "default",
}


def save():
    REPORT_FILE.write_text(json.dumps(REPORT, indent=2, ensure_ascii=False), encoding="utf-8")


def invoke(cdp, command, args=None):
    return cdp.js("window.__TAURI_INTERNALS__.invoke(" + json.dumps(command) + "," + json.dumps(args or {}) + ")")


def stop(process, cdp):
    cdp.close()
    process.terminate()
    process.wait(timeout=20)
    time.sleep(0.5)


def continue_session(cdp):
    return cdp.js("(()=>{const e=[...document.querySelectorAll('button')].find(e=>/Continue Session/i.test(e.innerText));if(!e)return false;e.click();return true})()")


def open_first(cdp):
    cdp.js("(()=>{const e=document.querySelector('[data-bench-id=thumbnail]');if(!e)throw Error('No library thumbnail');const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))})()")
    driver.wait_js(cdp, "!!document.querySelector('[data-bench-id=editor-first-frame]')", timeout=120)
    driver.wait_js(cdp, "baseline.filmstrip()?.selectedImage?.isReady", timeout=120)


def install(cdp):
    cdp.js(Path(__file__).with_name("observe.js").read_text(encoding="utf-8"))
    driver.wait_js(cdp, "baseline.listenerReady && baseline.errors.length===0")
    if cdp.js("({schema:baseline.schema,version:baseline.measurementVersion})") != {"schema": REPORT["schema"], "version": REPORT["measurementVersion"]}:
        raise RuntimeError("Observer version mismatch")


def viewport(cdp):
    page = cdp.js("({viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},userAgent:navigator.userAgent})")
    if page["viewport"] != {"width": 1280, "height": 720, "dpr": 1}:
        raise RuntimeError(f"Uncontrolled viewport: {page['viewport']}")
    return page


def preset_panel(cdp):
    expected = 20 if PRESETS20 else 0
    expression = """(()=>{const p=baseline.presetPanel();const expected=""" + str(expected) + """;
      const ids=p.cards.map(c=>c.id).sort();
      if(expected===0)return p.mountedCardCount===0?p:false;
      return p.visible&&p.visibleCardCount>0&&p.mountedCardCount===20&&p.cards.every(c=>c.inPanel)
        &&ids.every((id,i)=>id==='task1-'+String(i).padStart(2,'0'))?p:false;
    })()"""
    return driver.wait_js(cdp, expression)


def setup():
    manifest = json.loads((FIXTURE / "manifest.json").read_text(encoding="utf-8"))["files"]
    entries = []
    for index, entry in enumerate(manifest):
        path = (FIXTURE / entry["path"]).resolve()
        if not path.is_relative_to(FIXTURE.resolve()) or not path.is_file() or entry["kind"] not in ("RAW", "JPEG"):
            raise RuntimeError("Invalid dedicated fixture manifest entry")
        entries.append({"path": str(path), "kind": entry["kind"], "edited": index < 16})
    paths = [entry["path"] for entry in entries]
    if len(paths) != 164 or len(set(paths)) != 164 or any(sum(e["kind"] == kind for e in entries) != 82 for kind in ("RAW", "JPEG")):
        raise RuntimeError("Expected the dedicated 164-entry RAW/JPEG fixture")
    process, cdp, _ = driver.launch()
    try:
        driver.wait_js(cdp, "!!window.__TAURI_INTERNALS__ && document.body?.innerText.length>40")
        settings = invoke(cdp, "load_settings")
        settings.update({"language": "en", "rootFolders": [str(FIXTURE)], "lastRootPath": str(FIXTURE),
                         "grouping": "off", "libraryViewMode": "recursive",
                         "lastFolderState": {"currentFolderPath": str(FIXTURE), "expandedFolders": [str(FIXTURE)], "activeAlbumId": None, "expandedAlbumGroups": []}})
        presets = invoke(cdp, "load_presets")
        settings["workspace"] = {
            "leftPanelWidth": 350, "rightPanelWidth": 350, "leftTopHeight": 450, "rightTopHeight": 450,
            "panelLayout": {"leftTop": ["metadata", "folderTree", "export"], "leftBottom": [],
                            "rightTop": ["adjustments", "crop", "masks", "ai", "presets"], "rightBottom": []},
            "activePanels": {"leftTop": "folderTree", "leftBottom": None, "rightTop": "adjustments", "rightBottom": None},
            "panelSwitcherPlacement": {"leftTop": "bottom", "leftBottom": "bottom", "rightTop": "right", "rightBottom": "right"},
        }
        if PRESETS20:
            if any(not item.get("preset", {}).get("id", "").startswith("task1-") for item in presets):
                raise RuntimeError("Refuse to replace presets not created by this fixture")
            presets = [{"preset": {"id": f"task1-{index:02d}", "name": f"Task1 exposure {index:02d}",
                                   "adjustments": {"exposure": (index - 10) / 10}, "includeMasks": False,
                                   "includeCropTransform": False}} for index in range(20)]
            workspace = settings["workspace"]
            for region in workspace["panelLayout"]:
                workspace["panelLayout"][region] = [p for p in workspace["panelLayout"][region] if p != "presets"]
            workspace["panelLayout"]["leftBottom"].append("presets")
            workspace["activePanels"]["leftBottom"] = "presets"
            workspace["leftTopHeight"] = 220
        else:
            presets = [item for item in presets if not item.get("preset", {}).get("id", "").startswith("task1-")]
        invoke(cdp, "save_presets", {"presets": presets})
        REPORT["presetLibrary"] = {"count": len(presets), "workspace": settings["workspace"]}
        invoke(cdp, "save_settings", {"settings": settings})
        # Native writer resets all disposable copies, including edits from a
        # prior replay/drag. Null means unedited; no sidecar format is invented.
        for entry in entries:
            invoke(cdp, "save_metadata_and_update_thumbnail", {
                "path": entry["path"], "adjustments": {"exposure": 0.25} if entry["edited"] else None})
        REPORT["fixtureSetup"] = {"count": len(paths), "entries": entries,
                                  "editedPaths": [e["path"] for e in entries if e["edited"]], "settingsRoot": settings["rootFolders"]}
        save()
        cdp.js("window.fixtureThumbs=new Set();const cb=window.__TAURI_INTERNALS__.transformCallback(e=>window.fixtureThumbs.add(e.payload.path));window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'thumbnail-generated',target:{kind:'Any'},handler:cb})")
        invoke(cdp, "update_thumbnail_queue", {"paths": paths})
        driver.wait_js(cdp, "(" + json.dumps(paths) + ").every(p=>window.fixtureThumbs.has(p))", timeout=300)
        REPORT["fixtureSetup"]["generatedThumbnailPaths"] = cdp.js("[...window.fixtureThumbs]")
        invoke(cdp, "save_settings", {"settings": settings})
        save()
    finally:
        stop(process, cdp)


def measure():
    for index in range(6):
        process, cdp, timing = driver.launch()
        try:
            driver.wait_js(cdp, "[...document.querySelectorAll('button')].some(e=>/Continue Session/i.test(e.innerText))", timeout=120)
            timing["landingReadyUpperMs"] = (time.perf_counter() - timing["launchPerfCounter"]) * 1000
            timing.update({"index": index, "warmup": index == 0, "page": viewport(cdp)})
            install(cdp)
            if not continue_session(cdp):
                raise RuntimeError("Continue Session button not found")
            coverage = driver.wait_js(cdp, """(async()=>{
              const a=baseline.thumbnailCoverage();
              if(!a.expected||a.missing)return false;
              await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
              const b=baseline.thumbnailCoverage();
              return b.expected===a.expected&&b.mounted===a.mounted&&b.missing===0?b:false;
            })()""", timeout=120)
            timing["libraryThumbsUpperMs"] = (time.perf_counter() - timing["launchPerfCounter"]) * 1000
            timing["thumbnailCoverage"] = coverage
            open_first(cdp)
            timing["automatedEditorReadyUpperMs"] = (time.perf_counter() - timing["launchPerfCounter"]) * 1000
            timing["status"] = cdp.js("baseline.status()")
            timing["presetPanel"] = preset_panel(cdp)
            REPORT["startup"].append(timing)
            save()
            if index == 5:
                switch_and_scroll(cdp, process.pid)
                cdp.click('[data-bench-id="back-to-library"]')
                driver.wait_js(cdp, "!!document.querySelector('[data-bench-id=thumbnail]')")
                cdp.js("window.upstreamBenchResult=null;window.upstreamBenchErrors=[];const origError=console.error;console.error=(...args)=>{window.upstreamBenchErrors.push(args.map(String));origError(...args)};const orig=console.log;console.log=(...args)=>{for(const x of args){if(typeof x==='string'&&x.startsWith('{')){try{const j=JSON.parse(x);if(j.iterations&&j.summary)window.upstreamBenchResult=j}catch{}}}orig(...args)}")
                cdp.js((ROOT / "app/bench/replay.js").read_text(encoding="utf-8"))
                REPORT["upstreamReplay"] = cdp.js("window.upstreamBenchResult")
                REPORT["upstreamReplayErrors"] = cdp.js("window.upstreamBenchErrors")
                if not REPORT["upstreamReplay"] or REPORT["upstreamReplayErrors"]:
                    raise RuntimeError("Supplementary upstream replay incomplete or logged errors")
                save()
        finally:
            stop(process, cdp)


def switch_and_scroll(cdp, pid):
    entries = REPORT["fixtureSetup"]["entries"]
    expected = {e["path"]: e["edited"] for e in entries}
    driver.wait_js(cdp, "(()=>{const list=baseline.filmstrip()?.imageList;const expected=" + json.dumps(expected) + ";return list?.length===164&&list.every(e=>Object.hasOwn(expected,e.path)&&e.is_edited===expected[e.path])})()", timeout=120)
    phase = cdp.js("baseline.startSwitches()")
    phase["pid"] = pid
    phase["presetPanelBefore"] = preset_panel(cdp)
    REPORT["switchPhase"] = phase
    seen = set(phase["seenPaths"])
    targets = []
    # Each of four edit/format cells has five distinct paths, then each path is
    # selected again. First means first selected in this process, not cold IO.
    for edited in (True, False):
        for kind in ("RAW", "JPEG"):
            candidates = [e for e in entries if e["edited"] == edited and e["kind"] == kind and e["path"] not in seen]
            if len(candidates) < 5:
                raise RuntimeError(f"Insufficient first-selection targets for {edited}/{kind}")
            targets.extend(candidates[:5])
    plan = [{"targetPath": e["path"], "edited": e["edited"], "kind": e["kind"], "selection": selection}
            for selection in ("first-selection", "repeated-selection") for e in targets]
    REPORT["switchPlan"] = plan
    save()
    for index, sample in enumerate(plan):
        point = cdp.js("baseline.reveal(" + json.dumps(sample["targetPath"]) + ")")
        sample = {**sample, "index": index}
        cdp.js("baseline.arm(" + json.dumps(sample) + ")")
        for event in ("mousePressed", "mouseReleased"):
            cdp.call("Input.dispatchMouseEvent", {"type": event, "button": "left", "buttons": 1 if event == "mousePressed" else 0, "clickCount": 1, **point})
        driver.wait_js(cdp, f"(()=>{{if(baseline.errors.length)throw Error(JSON.stringify(baseline.errors));const r=baseline.clicks[{index}];return r?.readyAt&&r?.previewAt}})()", timeout=120)
        row = cdp.js("baseline.finish()")
        row["gpuFrames"] = cdp.js(f"baseline.frames.filter(e=>e.at>={row['start']}&&e.at<={row['end']})")
        REPORT["switches"].append(row)
        save()
    REPORT["switchPhase"].update(cdp.js("baseline.endSwitches()"))
    REPORT["switchPhase"]["presetPanelAfter"] = preset_panel(cdp)
    REPORT["filmstripScroll"] = cdp.js("""(async()=>{
      const scroller=baseline.scroller();scroller.scrollLeft=0;
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const frames=[];let previous=performance.now();const start=previous;
      for(let i=0;i<180;i++){
        await new Promise(requestAnimationFrame);const now=performance.now();
        const coverage=baseline.thumbnailCoverage('[data-tooltip^="photo-"]');
        frames.push({at:now,deltaMs:now-previous,visible:coverage.expected,loaded:coverage.loaded,missing:coverage.missing,scrollLeft:scroller.scrollLeft});
        previous=now;scroller.scrollLeft=(i<90?i:180-i)*80;
      }
      return {start,end:performance.now(),width:scroller.clientWidth,scrollWidth:scroller.scrollWidth,frames};
    })()""")
    save()


def measure_slider():
    # A separate process, after ALL switch samples and scroll/replay. Never
    # restore with keys or edit an unedited-group fixture. Select an explicit
    # editedPaths member even if library sorting opens another image first.
    target_path = REPORT["fixtureSetup"]["editedPaths"][0]
    process, cdp, _ = driver.launch()
    try:
        driver.wait_js(cdp, "[...document.querySelectorAll('button')].some(e=>/Continue Session/i.test(e.innerText))", timeout=120)
        page = viewport(cdp)
        install(cdp)
        if not continue_session(cdp):
            raise RuntimeError("Continue Session button not found for isolated drag")
        driver.wait_js(cdp, "baseline.thumbnailCoverage().expected>0", timeout=120)
        open_first(cdp)
        if cdp.js("baseline.filmstrip().selectedImage.path") != target_path:
            target_point = cdp.js("baseline.reveal(" + json.dumps(target_path) + ")")
            for event in ("mousePressed", "mouseReleased"):
                cdp.call("Input.dispatchMouseEvent", {"type": event, "button": "left", "buttons": 1 if event == "mousePressed" else 0, "clickCount": 1, **target_point})
        driver.wait_js(cdp, "(()=>{const s=baseline.filmstrip()?.selectedImage;return s?.path===" + json.dumps(target_path) + "&&s.isReady})()", timeout=120)
        panel = preset_panel(cdp)
        point = cdp.js("""(()=>{
          const e=[...document.querySelectorAll('input.slider-input')].find(e=>{
            const r=e.getBoundingClientRect();return !e.disabled&&r.width>60&&r.height>0&&r.x>innerWidth/2&&r.y>0&&r.bottom<innerHeight;
          });if(!e)throw Error('No visible Adjustments slider');
          const r=e.getBoundingClientRect();const f=(Number(e.value)-Number(e.min))/(Number(e.max)-Number(e.min));
          const x=r.left+Math.max(0.1,Math.min(0.9,f))*r.width,y=r.top+r.height/2;
          if(!Number.isFinite(x)||document.elementFromPoint(x,y)!==e)throw Error('Invalid or occluded slider');
          baseline.beginDrag(e,""" + json.dumps(target_path) + """);return {x,y,endX:x+(f<0.5?1:-1)*r.width*0.2};
        })()""")
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": point["x"], "y": point["y"], "buttons": 0})
        cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": point["x"], "y": point["y"], "button": "left", "buttons": 1, "clickCount": 1})
        try:
            for step in range(1, 13):
                x = point["x"] + (point["endX"] - point["x"]) * step / 12
                cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": point["y"], "button": "left", "buttons": 1})
                cdp.js("new Promise(requestAnimationFrame)")
        finally:
            cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": point["endX"], "y": point["y"], "button": "left", "buttons": 0, "clickCount": 1})
        result = cdp.js("baseline.finishDrag()")
        result.update({"pid": process.pid, "startupPids": [r["pid"] for r in REPORT["startup"]],
                       "page": page, "presetPanel": panel, "inputMethod": "CDP Input.dispatchMouseEvent", "points": point,
                       "switchSamplesInProcess": cdp.js("baseline.clicks.length")})
        REPORT["sliderDrag"] = result
        save()
        if not all(result["assertions"].values()) or result["samples"] < 12:
            raise RuntimeError("Isolated slider drag failed: " + json.dumps(result["assertions"]))
    finally:
        stop(process, cdp)


if __name__ == "__main__":
    if sys.argv[1:] not in ([], ["--presets20"]):
        raise SystemExit("Usage: windows-measure.py [--presets20]")
    if REPORT_FILE.exists():
        raise SystemExit(f"Refuse to overwrite {REPORT_FILE}; keep old/failed attempts in the Windows workspace, outside final evidence")
    try:
        setup()
        measure()
        measure_slider()
        REPORT["assertions"] = {"switchesComplete": len(REPORT["switches"]) == 40,
                                "startupComplete": len(REPORT["startup"]) == 6,
                                "isolatedMouseDrag": all(REPORT["sliderDrag"]["assertions"].values()),
                                "keyboardFree": REPORT["switchPhase"]["keyboardEvents"] == 0,
                                "targetPathsVerified": all(all(r["assertions"].values()) for r in REPORT["switches"])}
        if not all(REPORT["assertions"].values()):
            raise RuntimeError("Incomplete measurement assertions")
        REPORT["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        save()
    except Exception:
        REPORT["error"] = traceback.format_exc()
        save()
        raise
