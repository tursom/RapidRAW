"""Control an unmodified release WebView2 app in the logged-in desktop session.

Use the task1-only directory; never point this at personal image directories.
Requires websocket-client, Pillow and pywin32 (installed in the prior test venv).
CDP changes only ephemeral observation state, never the application bundle.
"""

import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

import websocket
import win32gui
import win32process

ROOT = Path(r"E:\projects\tbt\rapidraw-baseline")
EXE = ROOT / "app/src-tauri/target/release/RapidRAW.exe"
OUT = ROOT / "evidence"
OUT.mkdir(exist_ok=True)
PORT = 9431


class CDP:
    def __init__(self, timeout=60):
        deadline = time.perf_counter() + timeout
        while True:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=1) as response:
                    pages = json.load(response)
                page = next(p for p in pages if p.get("type") == "page" and not p.get("url", "").startswith("devtools:"))
                self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=90, suppress_origin=True)
                self.seq = 0
                return
            except Exception:
                if time.perf_counter() > deadline:
                    raise
                time.sleep(0.02)

    def call(self, method, params=None):
        self.seq += 1
        self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params or {}}))
        while True:
            result = json.loads(self.ws.recv())
            if result.get("id") == self.seq:
                if "error" in result:
                    raise RuntimeError(result["error"])
                return result.get("result", {})

    def js(self, expression):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if result.get("exceptionDetails"):
            raise RuntimeError(result["exceptionDetails"])
        return result.get("result", {}).get("value")

    def click(self, selector):
        self.js("document.querySelector(" + json.dumps(selector) + ")?.scrollIntoView({block:'nearest',inline:'nearest'})")
        self.js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
        point = self.js("(()=>{const e=document.querySelector(" + json.dumps(selector) + ");if(!e)throw Error('missing target');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
        self.call("Input.dispatchMouseEvent", {"type": "mousePressed", "button": "left", "clickCount": 1, **point})
        self.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "button": "left", "clickCount": 1, **point})

    def close(self):
        self.ws.close()


def launch(*args, reset_window_state=True):
    # Existing outer-size save / inner-size restore grows the window each run.
    # Reset only this task's fork configuration, outside the timing window.
    config = Path(os.environ["APPDATA"]) / "io.github.tursom.RapidRAW"
    config.mkdir(parents=True, exist_ok=True)
    # The window-size fix restores the requested client size. The historical
    # v3 binary needed a 689px seed to compensate for its extra 31px; set
    # RAPIDRAW_BASELINE_SEED_HEIGHT=689 only when reproducing that old binary.
    # Every measurement still checks the actual CSS viewport, not this seed.
    window_state = {"width": 1280, "height": int(os.environ.get("RAPIDRAW_BASELINE_SEED_HEIGHT", "720")), "x": 100, "y": 100,
                    "maximized": False, "fullscreen": False}
    state_file = config / "window_state.json"
    if reset_window_state:
        state_file.write_text(json.dumps(window_state), encoding="utf-8")
    else:
        window_state = json.loads(state_file.read_text(encoding="utf-8"))
    env = os.environ.copy()
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={PORT}"
    started = time.perf_counter()
    process = subprocess.Popen([str(EXE), *map(str, args)], cwd=EXE.parent, env=env,
                               stdout=open(ROOT / "logs/app-stdout.log", "a"), stderr=subprocess.STDOUT)
    try:
        cdp = CDP()
        attached = time.perf_counter()
        deadline = time.perf_counter() + 60
        while True:
            visible = []

            def visit(hwnd, _):
                if (win32process.GetWindowThreadProcessId(hwnd)[1] == process.pid
                        and win32gui.IsWindowVisible(hwnd)
                        and win32gui.GetWindowText(hwnd) == "RapidRAW TBT"):
                    visible.append(hwnd)

            win32gui.EnumWindows(visit, None)
            if visible:
                break
            if process.poll() is not None or time.perf_counter() >= deadline:
                raise RuntimeError("Fresh release process did not show its branded main window")
            time.sleep(0.02)
        visible_at = time.perf_counter()
    except Exception:
        if "cdp" in locals():
            cdp.close()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=20)
        raise
    return process, cdp, {"pid": process.pid, "attachMs": (attached - started) * 1000,
                          "nativeVisibleUpperMs": (visible_at - started) * 1000,
                          "initialWindowState": window_state,
                          "launchPerfCounter": started}


def wait_js(cdp, expression, timeout=60):
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline:
        result = cdp.js(expression)
        if result:
            return result
        time.sleep(0.02)
    raise TimeoutError(expression)


if __name__ == "__main__":
    process, cdp, timing = launch()
    wait_js(cdp, "document.body && document.body.innerText.length > 40")
    timing["dom"] = cdp.js("({text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(e=>({text:e.innerText,title:e.title,tooltip:e.dataset.tooltip})),url:location.href})")
    (OUT / "initial-inspection.json").write_text(json.dumps(timing, indent=2, ensure_ascii=False), encoding="utf-8")
    cdp.close()
    print(json.dumps({"pid": process.pid, "inspection": str(OUT / "initial-inspection.json")}))
