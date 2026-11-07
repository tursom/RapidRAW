"""Verify real main-window persistence; use only this fork's disposable profile.

Requires the existing baseline CDP driver and pywin32. Closes only windows it
launches; refuses existing branded windows. Original profile bytes are restored.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time
import traceback

import win32con
import win32gui
import win32process

parser = argparse.ArgumentParser()
parser.add_argument("--driver", type=Path, required=True)
parser.add_argument("--original", type=Path, required=True)
parser.add_argument("--fixed", type=Path, required=True)
parser.add_argument("--workspace", type=Path, required=True)
args = parser.parse_args()
if os.environ.get("RAPIDRAW_BASELINE_SEED_HEIGHT"):
    raise SystemExit("Unset RAPIDRAW_BASELINE_SEED_HEIGHT; this suite tests both the default and the legacy override")
spec = importlib.util.spec_from_file_location("window_driver", args.driver)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
driver.ROOT = args.workspace
driver.OUT = args.workspace / "evidence"
driver.OUT.mkdir(parents=True, exist_ok=True)
(args.workspace / "logs").mkdir(exist_ok=True)
output = driver.OUT / "verification.json"
if output.exists():
    raise SystemExit(f"Refuse to overwrite {output}")

existing = []
win32gui.EnumWindows(lambda hwnd, _: existing.append(hwnd)
                     if win32gui.GetWindowText(hwnd) == "RapidRAW TBT" else None, None)
if existing:
    raise SystemExit("Close existing RapidRAW TBT windows before verification")
config = Path(os.environ["APPDATA"]) / "io.github.tursom.RapidRAW"
config.mkdir(parents=True, exist_ok=True)
files = [config / "window_state.json", config / "settings.json"]
original_bytes = {path: path.read_bytes() if path.exists() else None for path in files}
report = {"schema": "rapidraw-window-size-verification", "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
          "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          "driverSha256": hashlib.sha256(args.driver.read_bytes()).hexdigest(),
          "originalExeSha256": hashlib.sha256(args.original.read_bytes()).hexdigest(),
          "fixedExeSha256": hashlib.sha256(args.fixed.read_bytes()).hexdigest(), "cases": []}


def wait_for(predicate):
    deadline = time.perf_counter() + 15
    while time.perf_counter() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise TimeoutError("Window state transition timed out")


def read_state():
    return json.loads(files[0].read_text(encoding="utf-8-sig"))


def maximized(hwnd):
    return win32gui.GetWindowPlacement(hwnd)[1] == win32con.SW_SHOWMAXIMIZED


def fullscreen(cdp):
    return cdp.js("window.__TAURI_INTERNALS__.invoke('plugin:window|is_fullscreen',{label:'main'})")


def snapshot(hwnd, cdp):
    # Let the existing 500ms saver flush after visibility or a window action.
    time.sleep(2)
    return {"outerRect": list(win32gui.GetWindowRect(hwnd)),
            "clientRect": list(win32gui.GetClientRect(hwnd)),
            "page": cdp.js("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})"),
            "maximized": maximized(hwnd), "fullscreen": fullscreen(cdp), "saved": read_state()}


def size(row):
    r = row["clientRect"]
    return [r[2] - r[0], r[3] - r[1]]


class HeldReadyCDP(driver.CDP):
    def __init__(self):
        super().__init__()
        visible = []
        win32gui.EnumWindows(lambda h, _: visible.append(h)
                             if win32gui.IsWindowVisible(h) and win32gui.GetWindowText(h) == "RapidRAW TBT"
                             else None, None)
        if visible:
            raise RuntimeError("Cannot establish fallback control: window already visible")
        driver.wait_js(self, """(()=>{
          if(!window.__TAURI_INTERNALS__?.invoke||typeof window.fetch!=='function')return false;
          const original=window.fetch, held={blocked:0,released:0,queue:[]};
          window.__windowSizeHeldReady=held;
          const intercept=(...args)=>{
            const input=args[0],url=new URL(typeof input==='string'?input:input.url,location.href);
            if(url.hostname!=='ipc.localhost'||url.pathname!=='/frontend_ready')return original.apply(window,args);
            held.blocked++;
            return new Promise((resolve,reject)=>held.queue.push(()=>{
              const result=original.apply(window,args);result.then(resolve,reject);return result;
            }));
          };
          window.fetch=intercept;
          if(window.fetch!==intercept)return false;
          held.resume=()=>{
            window.fetch=original;
            const batch=held.queue.splice(0);held.released+=batch.length;
            return Promise.all(batch.map(run=>run()));
          };
          return true;
        })()""", timeout=3)
        visible.clear()
        win32gui.EnumWindows(lambda h, _: visible.append(h)
                             if win32gui.IsWindowVisible(h) and win32gui.GetWindowText(h) == "RapidRAW TBT"
                             else None, None)
        if visible:
            raise RuntimeError("Cannot establish fallback control: window became visible before interception")


def run_case(name, executable, decorations=False, action=None, expect_growth=False, invalid_seed=False, use_driver_seed=False, hold_first_ready=False):
    driver.EXE = executable
    settings = json.loads((original_bytes[files[1]] or b"{}").decode("utf-8-sig"))
    settings["decorations"] = decorations
    files[1].write_text(json.dumps(settings, ensure_ascii=False), encoding="utf-8")
    seed = {"width": 1280, "height": 689 if expect_growth else 720, "x": 100, "y": 100,
            "maximized": False, "fullscreen": False}
    if invalid_seed:
        seed.update(width=1, height=1)
    files[0].write_text(json.dumps(seed), encoding="utf-8")
    case = {"name": name, "decorations": decorations, "seed": seed,
            "holdFirstReady": hold_first_ready, "useDriverSeed": use_driver_seed, "launches": []}
    report["cases"].append(case)
    for index in range(3):
        # Seed once; every subsequent launch must consume the previous save.
        normal_cdp = driver.CDP
        if hold_first_ready and index == 0:
            driver.CDP = HeldReadyCDP
        legacy_override = use_driver_seed and index == 0 and expect_growth
        if legacy_override:
            os.environ["RAPIDRAW_BASELINE_SEED_HEIGHT"] = "689"
        try:
            process, cdp, timing = driver.launch(reset_window_state=use_driver_seed and index == 0)
        finally:
            driver.CDP = normal_cdp
            if legacy_override:
                os.environ.pop("RAPIDRAW_BASELINE_SEED_HEIGHT")
        try:
            driver.wait_js(cdp, "document.body?.innerText.length>40")
            windows = []
            win32gui.EnumWindows(lambda h, _: windows.append(h)
                                 if win32process.GetWindowThreadProcessId(h)[1] == process.pid
                                 and win32gui.IsWindowVisible(h)
                                 and win32gui.GetWindowText(h) == "RapidRAW TBT" else None, None)
            if len(windows) != 1:
                raise RuntimeError("Missing/ambiguous main window")
            hwnd = windows[0]
            row = {"index": index, "pid": process.pid, "initialState": timing["initialWindowState"]}
            case["launches"].append(row)
            if hold_first_ready and index == 0:
                row["heldReady"] = cdp.js("({blocked:__windowSizeHeldReady.blocked,pending:__windowSizeHeldReady.queue.length,released:__windowSizeHeldReady.released})")
                row["nativeVisibleUpperMs"] = timing["nativeVisibleUpperMs"]
                assert row["heldReady"]["pending"] > 0 and row["heldReady"]["released"] == 0, "frontend_ready was not withheld"
                assert timing["nativeVisibleUpperMs"] >= 3900, "Window appeared before the four-second fallback"
            if action == "maximize-restore" and index == 1:
                wait_for(lambda: maximized(hwnd))
            if action == "fullscreen-restore" and index == 1:
                wait_for(lambda: fullscreen(cdp))
            row["beforeAction"] = snapshot(hwnd, cdp)
            if index == 0 and action == "resize":
                win32gui.MoveWindow(hwnd, 140, 140, 1160, 760, True)
                row["action"] = {"kind": "native-resize", "outerRect": [140, 140, 1300, 900]}
            elif action == "maximize-restore" and index in (0, 1):
                maximize = index == 0
                win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE if maximize else win32con.SW_RESTORE)
                wait_for(lambda: maximized(hwnd) == maximize)
                row["action"] = {"kind": "maximize" if maximize else "restore"}
            elif action == "fullscreen-restore" and index in (0, 1):
                enter = index == 0
                cdp.js("window.__TAURI_INTERNALS__.invoke('plugin:window|set_fullscreen'," + json.dumps({"label": "main", "value": enter}) + ")")
                wait_for(lambda: fullscreen(cdp) == enter)
                row["action"] = {"kind": "fullscreen" if enter else "exit-fullscreen"}
            row["afterAction"] = snapshot(hwnd, cdp) if "action" in row else row["beforeAction"]
            if index == 0 and action == "resize":
                if hold_first_ready:
                    cdp.js("window.__windowSizeHeldReady.resume()")
                    row["releasedReady"] = cdp.js("({blocked:__windowSizeHeldReady.blocked,pending:__windowSizeHeldReady.queue.length,released:__windowSizeHeldReady.released})")
                    assert row["releasedReady"]["pending"] == 0 and row["releasedReady"]["released"] > 0
                else:
                    cdp.js("window.__TAURI_INTERNALS__.invoke('frontend_ready')")
                row["afterRepeatedReady"] = snapshot(hwnd, cdp)
                assert size(row["afterRepeatedReady"]) == size(row["afterAction"]), "Repeated frontend_ready reset a user resize"
            cdp.close()
            win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
            process.wait(timeout=20)
            row["savedAfterClose"] = read_state()
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=20)
                cdp.close()
    rows = case["launches"]
    assert all(rows[i]["initialState"] == rows[i - 1]["savedAfterClose"] for i in (1, 2)), "State reset between launches"
    if expect_growth:
        sizes = [size(row["afterAction"]) for row in rows]
        assert all(b[0] > a[0] and b[1] > a[1] for a, b in zip(sizes, sizes[1:])), "Original bug did not reproduce"
    else:
        first_size = size(rows[0]["beforeAction"])
        if invalid_seed:
            assert first_size[0] >= 800 and first_size[1] >= 600, "Invalid state did not use a usable default"
        else:
            assert first_size == [seed["width"], seed["height"]], "First show changed the requested client size"
        for row in rows:
            for stage in ("beforeAction", "afterAction"):
                snap = row[stage]
                if not snap["maximized"] and not snap["fullscreen"]:
                    assert size(snap) == [snap["saved"]["width"], snap["saved"]["height"]], "Saved size is not client size"
                assert snap["page"]["dpr"] == 1, "Unexpected display scale"
                assert size(snap) == [snap["page"]["width"], snap["page"]["height"]], "WebView/client sizes disagree"
            assert row["savedAfterClose"] == row["afterAction"]["saved"], "Unsaved close state"
        normal = rows[0]["beforeAction"] if action in ("maximize-restore", "fullscreen-restore") else rows[0]["afterAction"]
        for row in rows[1:]:
            restored = row["afterAction"]
            assert not restored["maximized"] and not restored["fullscreen"] and size(restored) == size(normal), "Window grew after relaunch/restore"
        if action == "maximize-restore":
            assert rows[0]["savedAfterClose"]["maximized"] is True
            assert rows[1]["beforeAction"]["maximized"] is True
            assert rows[1]["savedAfterClose"]["maximized"] is False
        if action == "fullscreen-restore":
            assert rows[0]["savedAfterClose"]["fullscreen"] is True
            assert rows[1]["beforeAction"]["fullscreen"] is True
            assert rows[1]["savedAfterClose"]["fullscreen"] is False
    case["passed"] = True


try:
    run_case("original-growth-control", args.original, expect_growth=True, use_driver_seed=True)
    run_case("fixed-frameless", args.fixed, use_driver_seed=True)
    run_case("fixed-decorated", args.fixed, decorations=True)
    run_case("fixed-invalid-state-default", args.fixed, invalid_seed=True)
    run_case("fixed-user-resize", args.fixed, action="resize")
    run_case("fixed-maximize-restore", args.fixed, action="maximize-restore")
    run_case("fixed-fullscreen-restore", args.fixed, action="fullscreen-restore")
    run_case("fixed-fallback-late-ready", args.fixed, action="resize", hold_first_ready=True)
    report["passed"] = True
except Exception:
    report["error"] = traceback.format_exc()
    raise
finally:
    for path, contents in original_bytes.items():
        if contents is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(contents)
    report["profileRestored"] = all((path.read_bytes() if path.exists() else None) == contents
                                    for path, contents in original_bytes.items())
    report["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
