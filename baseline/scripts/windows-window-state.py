"""Three consecutive launches, without resetting state between launches.

Diagnostic only: do not resize/move the window or fix application behavior.
The dedicated fork's original state is restored after the probe.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time

import win32con
import win32gui
import win32process

spec = importlib.util.spec_from_file_location("cdp_driver", Path(__file__).with_name("windows-cdp.py"))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
state_file = Path(os.environ["APPDATA"]) / "io.github.tursom.RapidRAW/window_state.json"
output = driver.OUT / "window-state-probe.json"
if output.exists():
    raise SystemExit(f"Refuse to overwrite {output}")
original = state_file.read_bytes() if state_file.exists() else None
report = {"schema": "rapidraw-task1-window-state", "launches": [],
          "exeSha256": hashlib.sha256(driver.EXE.read_bytes()).hexdigest(),
          "method": "Seed once; launch three times; wait 2 seconds for the 500ms saver; close native window; no injected resize/move"}
try:
    for index in range(3):
        process, cdp, timing = driver.launch(reset_window_state=index == 0)
        try:
            driver.wait_js(cdp, "document.body?.innerText.length>40")
            time.sleep(2)
            windows = []

            def visit(hwnd, _):
                if (win32process.GetWindowThreadProcessId(hwnd)[1] == process.pid
                        and win32gui.IsWindowVisible(hwnd)
                        and win32gui.GetWindowText(hwnd) == "RapidRAW TBT"):
                    windows.append(hwnd)

            win32gui.EnumWindows(visit, None)
            if len(windows) != 1:
                raise RuntimeError("Ambiguous main window")
            hwnd = windows[0]
            row = {"index": index, "timing": timing,
                   "outerRect": list(win32gui.GetWindowRect(hwnd)),
                   "clientRect": list(win32gui.GetClientRect(hwnd)),
                   "page": cdp.js("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})"),
                   "savedWhileVisible": json.loads(state_file.read_text(encoding="utf-8"))}
            cdp.close()
            win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
            process.wait(timeout=20)
            row["savedAfterClose"] = json.loads(state_file.read_text(encoding="utf-8"))
            report["launches"].append(row)
        finally:
            if process.poll() is None:
                cdp.close()
                process.terminate()
                process.wait(timeout=20)
    report["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
finally:
    if original is None:
        state_file.unlink(missing_ok=True)
    else:
        state_file.write_bytes(original)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
