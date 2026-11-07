"""Exercise the built Tauri slider with trusted CDP input on a disposable RAW.

Run in an Interactive Windows session. Preserve this fork's profile bytes;
never point the fixture at personal photos. Original photo bytes must not change.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
import traceback

import win32con
import win32gui
import win32process

ROOT = Path(r"E:\projects\tbt\rapidraw-slider")
BASE = Path(r"E:\projects\tbt\rapidraw-baseline")
spec = importlib.util.spec_from_file_location("driver", ROOT / "windows-cdp.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
driver.ROOT, driver.OUT = ROOT, ROOT / "evidence"
driver.EXE = BASE / "app/src-tauri/target/release/RapidRAW-slider.exe"
PHOTO = ROOT / "fixture/photo-000.NEF"
OUTPUT = driver.OUT / "windows-smoke.json"
if OUTPUT.exists():
    raise SystemExit("Refuse to overwrite smoke evidence")
existing = []
win32gui.EnumWindows(lambda h, _: existing.append(h) if win32gui.GetWindowText(h) == "RapidRAW TBT" else None, None)
if existing:
    raise SystemExit("Close existing RapidRAW TBT windows before using the disposable test profile")
config = Path(os.environ["APPDATA"]) / "io.github.tursom.RapidRAW"
files = [config / "settings.json", config / "window_state.json"]
original = {p: p.read_bytes() if p.exists() else None for p in files}
fixture = json.loads((driver.OUT / "fixture.json").read_text(encoding="utf-8-sig"))
assert hashlib.sha256(PHOTO.read_bytes()).hexdigest() == fixture["sha256"]
report = {"schema": "rapidraw-slider-windows-smoke", "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
          "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          "driverSha256": hashlib.sha256((ROOT / "windows-cdp.py").read_bytes()).hexdigest(),
          "observerSha256": hashlib.sha256((ROOT / "observe.js").read_bytes()).hexdigest(),
          "exeSha256": hashlib.sha256(driver.EXE.read_bytes()).hexdigest(),
          "fixture": fixture, "cases": []}
process = cdp = None
selector = '[data-speed-edit-id="contrast"] input[type="range"]'


def invoke(command, args=None):
    return cdp.js("window.__TAURI_INTERNALS__.invoke(" + json.dumps(command) + "," + json.dumps(args or {}) + ")")


def read(drain=True):
    return cdp.js("""(()=>{
      const node=document.querySelector('""" + selector + """');if(!node)throw Error('No contrast input');
      let fiber=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))],props;
      while(fiber){let root=fiber;while(root.return)root=root.return;
        const current=root.stateNode?.current===root?fiber:fiber.alternate;
        if(current?.memoizedProps?.speedEditId==='contrast'&&typeof current.memoizedProps.value==='number'){
          props=current.memoizedProps;break;
        }fiber=fiber.return;
      }if(!props)throw Error('No current Slider props');
      return {value:props.value,min:props.min,max:props.max,step:props.step,
        selectedPath:baseline.filmstrip().selectedImage.path,focused:document.activeElement===node,
        viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
        events:""" + ("window.sliderSmoke.events.splice(0)" if drain else "[...window.sliderSmoke.events]") + """,
        windowKeys:""" + ("window.sliderSmoke.windowKeys.splice(0)" if drain else "[...window.sliderSmoke.windowKeys]") + """};
    })()""")


def frame():
    cdp.js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")


def require_events(row, expected):
    for event_type, role, key_name in expected:
        assert any(e["trusted"] and e["type"] == event_type and e["role"] == role
                   and (key_name is None or e["key"] == key_name) for e in row["events"]), (
                       "Missing trusted input " + str((event_type, role, key_name)) + ": " + json.dumps(row))


def record(name, predicate, expected):
    frame()
    row = read()
    row["name"] = name
    assert row["selectedPath"] == str(PHOTO), "Selection changed"
    assert row["viewport"] == {"width": 1280, "height": 720, "dpr": 1}
    require_events(row, expected)
    assert predicate(row), name + ": " + json.dumps(row)
    report["cases"].append(row)
    return row


def mouse(kind, x, modifiers=0, count=1):
    cdp.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": point["y"],
             "button": "left" if kind != "mouseMoved" else "none", "clickCount": count,
             "buttons": 0 if kind == "mouseReleased" else 1, "modifiers": modifiers})


def click(x, modifiers=0):
    time.sleep(0.18)  # Keep ordinary clicks outside the existing double-click guard.
    cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": point["y"],
             "button": "none", "buttons": 0, "modifiers": modifiers})
    frame()
    mouse("mousePressed", x, modifiers)
    frame()
    report.setdefault("pointerDownSamples", []).append({"requestedX": x, "modifiers": modifiers, "state": read(False)})
    mouse("mouseReleased", x, modifiers)
    frame()


def key(name):
    for kind in ("keyDown", "keyUp"):
        cdp.call("Input.dispatchKeyEvent", {"type": kind, "key": name, "code": name})


try:
    settings = json.loads((original[files[0]] or b"{}").decode("utf-8-sig"))
    settings.update({"language": "en", "decorations": False, "rootFolders": [str(PHOTO.parent)],
                     "lastRootPath": str(PHOTO.parent), "grouping": "off", "libraryViewMode": "recursive",
                     "lastFolderState": {"currentFolderPath": str(PHOTO.parent), "expandedFolders": [str(PHOTO.parent)],
                                         "activeAlbumId": None, "expandedAlbumGroups": []},
                     "workspace": {"leftPanelWidth": 350, "rightPanelWidth": 350, "leftTopHeight": 450, "rightTopHeight": 450,
                       "panelLayout": {"leftTop": ["folderTree"], "leftBottom": [], "rightTop": ["adjustments"], "rightBottom": []},
                       "activePanels": {"leftTop": "folderTree", "leftBottom": None, "rightTop": "adjustments", "rightBottom": None},
                       "panelSwitcherPlacement": {"leftTop": "bottom", "leftBottom": "bottom", "rightTop": "right", "rightBottom": "right"}}})
    files[0].write_text(json.dumps(settings), encoding="utf-8")
    process, cdp, timing = driver.launch()
    report["launch"] = timing
    report["browser"] = cdp.call("Browser.getVersion")
    effective = invoke("load_settings")
    assert effective["rootFolders"] == [str(PHOTO.parent)], "Disposable fixture settings were not loaded"
    report["effectiveRootFolders"] = effective["rootFolders"]
    driver.wait_js(cdp, "[...document.querySelectorAll('button')].some(e=>/Continue Session/i.test(e.innerText))")
    cdp.js((ROOT / "observe.js").read_text(encoding="utf-8"))
    cdp.js("[...document.querySelectorAll('button')].find(e=>/Continue Session/i.test(e.innerText)).click()")
    driver.wait_js(cdp, "baseline.thumbnailCoverage().expected===1&&baseline.thumbnailCoverage().missing===0", timeout=120)
    cdp.js("document.querySelector('[data-bench-id=thumbnail]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
    driver.wait_js(cdp, "baseline.filmstrip()?.selectedImage?.isReady", timeout=120)
    assert cdp.js("baseline.filmstrip().selectedImage.path") == str(PHOTO)
    cdp.js("document.querySelector('" + selector + "').scrollIntoView({block:'center'})")
    frame()
    point = cdp.js("""(()=>{const e=document.querySelector('""" + selector + """'),r=e.getBoundingClientRect();
      const x=r.left+r.width/2,y=r.top+r.height/2;
      if(document.elementFromPoint(x,y)!==e)throw Error('Contrast is occluded');
      window.sliderSmoke={events:[],windowKeys:[]};
      const container=e.closest('[data-speed-edit-id=contrast]');
      for(const type of ['mousedown','mousemove','mouseup','click','touchstart','touchmove','touchend','keydown','keyup','beforeinput','input','wheel'])
        document.addEventListener(type,event=>{
          if(!container.contains(event.target))return;
          const role=event.target===e?'range':event.target.matches('input[type=text]')?'text':event.target.closest('.grid')?'label':'other';
          sliderSmoke.events.push({type,role,trusted:event.isTrusted,key:event.key??null,shift:event.shiftKey,alt:event.altKey,
            x:event.clientX??null,y:event.clientY??null});
        },true);
      window.addEventListener('keydown',event=>sliderSmoke.windowKeys.push({key:event.key,type:event.target.type}));
      return {x,y,left:r.left,width:r.width};})()""")
    report["rangeGeometry"] = point
    report["setupValueBeforeReset"] = read()["value"]
    reset = cdp.js("(()=>{const e=document.querySelector('[data-speed-edit-id=contrast] .grid'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
    for kind in ("mousePressed", "mouseReleased"):
        cdp.call("Input.dispatchMouseEvent", {"type": kind, "button": "left", "clickCount": 1, **reset})
    frame()
    report["setupReset"] = read()
    assert report["setupReset"]["value"] == 0
    require_events(report["setupReset"], [("click", "label", None)])
    track_events = [("mousedown", "range", None), ("mouseup", "range", None)]
    for offset in (4, -4):
        click(point["x"] + offset)
        record("track-inside-" + str(offset), lambda r: r["value"] == 0, track_events)
    for offset in (8, -8):
        click(point["x"] + offset)
        record("track-outside-" + str(offset), lambda r, sign=offset: r["value"] * sign > 0, track_events)
    for value, modifiers in ((1, 8), (-1, 1)):
        # WebView2 reports integer clientX. Choose the nearest actual pixel;
        # truncating the fractional target could fall into the adjacent step.
        click(round(point["x"] + value * point["width"] / 200), modifiers)
        record("fine-shift" if modifiers == 8 else "fine-alt", lambda r, value=value: r["value"] == value, track_events)
    for direction in (1, -1):
        time.sleep(0.18)
        mouse("mousePressed", point["x"] + direction * 24)
        frame()
        for offset in (direction * 3, -direction * 3, -direction * 8):
            mouse("mouseMoved", point["x"] + offset)
            record("drag-" + str(direction) + "-" + str(offset),
                   lambda r, offset=offset: r["value"] == 0 if abs(offset) <= 5 else r["value"] * offset > 0,
                   [("mousemove", "range", None)])
        mouse("mouseReleased", point["x"] - direction * 8)
        record("release-" + str(direction), lambda r, direction=direction: r["value"] * direction < 0,
               [("mouseup", "range", None)])
    click(point["x"])
    cdp.js("document.querySelector('" + selector + "').focus()")
    for name, value in (("ArrowUp", 1), ("ArrowDown", 0), ("ArrowDown", -1), ("ArrowRight", 0), ("ArrowRight", 1), ("ArrowLeft", 0)):
        key(name)
        record("focused-" + name + "-" + str(value), lambda r, value=value: r["value"] == value and r["focused"] and r["windowKeys"] == [],
               [("keydown", "range", name), ("keyup", "range", name)])
    for delta, value in ((-100, 1), (100, 0), (100, -1)):
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": point["x"], "y": point["y"], "deltaX": 0, "deltaY": delta, "modifiers": 8})
        record("shift-wheel-" + str(value), lambda r, value=value: r["value"] == value,
               [("wheel", "range", None)])
    for value in (1, -1):
        span = cdp.js("(()=>{const r=document.querySelector('[data-speed-edit-id=contrast] .w-14 > span').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
        cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "button": "left", "clickCount": 1, **span})
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "button": "left", "clickCount": 1, **span})
        driver.wait_js(cdp, "!!document.querySelector('[data-speed-edit-id=contrast] input[type=text]')")
        frame()
        cdp.call("Input.insertText", {"text": str(value)})
        key("Enter")
        record("text-" + str(value), lambda r, value=value: r["value"] == value,
               [("beforeinput", "text", None), ("input", "text", None), ("keydown", "text", "Enter")])
    report["passed"] = True
except Exception:
    report["error"] = traceback.format_exc()
    raise
finally:
    if process is not None and process.poll() is None:
        handles = []
        win32gui.EnumWindows(lambda h, _: handles.append(h) if win32process.GetWindowThreadProcessId(h)[1] == process.pid
                             and win32gui.IsWindowVisible(h) and win32gui.GetWindowText(h) == "RapidRAW TBT" else None, None)
        if cdp is not None:
            cdp.close()
        if len(handles) == 1:
            win32gui.PostMessage(handles[0], win32con.WM_CLOSE, 0, 0)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=20)
        else:
            process.terminate()
            process.wait(timeout=20)
    for path, data in original.items():
        if data is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(data)
    report["profileRestored"] = all((p.read_bytes() if p.exists() else None) == data for p, data in original.items())
    report["fixtureSha256After"] = hashlib.sha256(PHOTO.read_bytes()).hexdigest()
    cleanup_ok = report["profileRestored"] and report["fixtureSha256After"] == fixture["sha256"]
    report["passed"] = report.get("passed", False) and cleanup_ok
    if not cleanup_ok:
        report["cleanupError"] = "Profile restoration or original fixture hash verification failed"
    report["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    OUTPUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not cleanup_ok:
        raise RuntimeError(report["cleanupError"])
