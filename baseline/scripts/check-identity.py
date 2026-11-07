"""Verify the desktop name in the real release app, outside timed measurements."""

import hashlib
import importlib.util
import json
from pathlib import Path

import win32gui
import win32process
import win32ts

spec = importlib.util.spec_from_file_location("cdp_driver", Path(__file__).with_name("windows-cdp.py"))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

process, cdp, _ = driver.launch()
try:
    driver.wait_js(cdp, "[...document.querySelectorAll('p')].some(e=>e.textContent==='RapidRAW TBT')")
    windows = []

    def visit(hwnd, _):
        if win32process.GetWindowThreadProcessId(hwnd)[1] == process.pid:
            windows.append({"title": win32gui.GetWindowText(hwnd), "visible": bool(win32gui.IsWindowVisible(hwnd))})

    win32gui.EnumWindows(visit, None)
    assert any(w["visible"] and w["title"] == "RapidRAW TBT" for w in windows), windows
    binary = driver.EXE.read_bytes()
    fork_service = b"io.github.tursom.RapidRAW.immich"
    official_service = b"io.github.CyberTimon.RapidRAW.immich"
    assert fork_service in binary and official_service not in binary
    report = {
        "passed": True,
        "sessionId": win32ts.ProcessIdToSessionId(process.pid),
        "renderedTitle": "RapidRAW TBT",
        "nativeWindows": windows,
        "executableSha256": hashlib.sha256(binary).hexdigest(),
        "forkImmichServicePresentInBinary": True,
        "officialImmichServiceAbsentFromBinary": True,
        "scope": "Desktop titles and compiled service-name strings only; no credential values read or written by this check; not a keyring integration, macOS or installer coexistence test",
    }
    (driver.OUT / "identity.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
finally:
    cdp.close()
    process.terminate()
    process.wait(timeout=20)
