"""Measure actual release Tauri clipboard button/IPC after the CLI fixture run."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import traceback

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('windows-clipboard-release.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
REPORT = {'method': 'Actual release Tauri HTML5 window and clipboard button; physical Chrome copy menu; local fixtures, no formal import pipeline.', 'tests': [], 'started': time.strftime('%Y-%m-%dT%H:%M:%S%z')}


def save():
    (p.OUT / 'ui-results.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    server = p.socketserver.TCPServer(('127.0.0.1', 8767), p.functools.partial(p.Handler, directory=str(p.FIX)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = os.environ.copy()
    env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--remote-debugging-port=9346'
    env['WEBVIEW2_USER_DATA_FOLDER'] = str(p.ROOT / 'profiles' / 'release-ui-webview')
    exe = p.ROOT / 'artifacts' / 'intake-html5-release.exe'
    REPORT['executableSha256'] = p.hashlib.sha256(exe.read_bytes()).hexdigest()
    target = subprocess.Popen([str(exe)], env=env)
    browser = None
    app = src = None
    try:
        app = p.CDP(9346)
        deadline = time.time() + 30
        while not app.js("!!document.getElementById('clipboard') && !document.getElementById('clipboard').disabled"):
            if time.time() > deadline:
                raise TimeoutError('App not ready')
            time.sleep(.2)
        REPORT['environment'] = app.js('environment')
        REPORT['webview'] = app.meta
        assert REPORT['environment']['build']['profile'] == 'release'
        assert not REPORT['environment']['nativeDragDrop']
        width, height = p.win32api.GetSystemMetrics(0), p.win32api.GetSystemMetrics(1)
        hwnd = p.hwnd_for(target.pid)
        p.win32gui.MoveWindow(hwnd, width//2, 30, width//2, min(900, height-60), True)
        browser = subprocess.Popen([r'C:\Program Files\Google\Chrome\Application\chrome.exe', '--user-data-dir=' + str(p.ROOT / 'profiles' / 'release-ui-chrome'), '--no-first-run', '--no-default-browser-check', '--force-renderer-accessibility', '--remote-debugging-port=9353', '--new-window', 'http://127.0.0.1:8767/clipboard-release.html'])
        src = p.CDP(9353)
        deadline = time.time() + 30
        while not src.js('document.images.length===5 && [...document.images].every(i=>i.complete&&i.naturalWidth>0)'):
            if time.time() > deadline:
                raise TimeoutError('Source not ready')
            time.sleep(.2)
        source_hwnd = p.hwnd_for(browser.pid)
        p.win32gui.MoveWindow(source_hwnd, 0, 30, width//2, min(900, height-60), True)
        REPORT['browser'] = src.meta
        for index, fixture in enumerate(['small.jpg', 'large.jpg', 'photo-control.jpg']):
            expected = p.source_pixels(src, '#f' + str(index), fixture)
            for repeat in range(1, 4):
                modes = ['prefer-png', 'reencode'] if repeat % 2 else ['reencode', 'prefer-png']
                for mode in modes:
                    for attempt in range(1, 4):
                        try:
                            menu = p.copy_image(src, source_hwnd, '#f' + str(index))
                            break
                        except RuntimeError as error:
                            REPORT.setdefault('driverRetries', []).append(str(error))
                            if attempt == 3:
                                raise
                            time.sleep(.5)
                    before = app.js('records.length')
                    case = f'Chrome-{fixture}-{repeat}-{mode}'
                    app.js("document.getElementById('clipboard-mode').value=" + json.dumps(mode) + ";document.getElementById('source').value='Chrome release';document.getElementById('case').value=" + json.dumps(case) + ";document.getElementById('clipboard').click()")
                    deadline = time.time() + 90
                    while True:
                        rows = app.js('records.slice(' + str(before) + ')')
                        end = next((r for r in rows if r['type'] in ['system-clipboard', 'clipboard-error']), None)
                        if end:
                            break
                        if time.time() > deadline:
                            raise TimeoutError('Clipboard button still pending')
                        time.sleep(.1)
                    assert end['type'] == 'system-clipboard'
                    after_probe = p.ctypes.windll.user32.GetClipboardSequenceNumber()
                    ref = p.reference_png()
                    p.verify(end['data'], ref, mode, expected)
                    assert after_probe == ref['sequences'][0]
                    REPORT['tests'].append({'case': case, 'fixture': fixture, 'repeat': repeat, 'mode': mode, 'menu': menu, 'sourcePixels': expected, 'sequenceAfterProbe': after_probe, 'record': end, 'reference': ref, 'verified': True})
                    save()
                    print(case, flush=True)
        app.js("document.getElementById('export').click()")
        deadline = time.time() + 10
        while not app.js("records.some(r=>r.type==='report-saved')"):
            if time.time() > deadline:
                raise TimeoutError('Report not saved')
            time.sleep(.1)
        REPORT['records'] = app.js('records')
        REPORT['passed'] = True
        REPORT['finished'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        save()
    finally:
        if src:
            try:
                src.call('Browser.close')
                browser.wait(timeout=15)
            finally:
                src.ws.close()
        if app:
            app.ws.close()
        for process in [browser, target]:
            if process and process.poll() is None:
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=15)
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        REPORT['fatalError'] = traceback.format_exc()
        REPORT['passed'] = False
        save()
        raise
