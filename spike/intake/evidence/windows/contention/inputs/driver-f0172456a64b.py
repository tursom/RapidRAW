"""Interactive Windows browser-copy contention experiment (PLAN phase 1 item 5).
The Rust process is armed before the native copy-menu click. No clipboard format,
file, or text probe precedes its first get_buffer('PNG'). Never imports into RapidRAW.
"""
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import socketserver
import subprocess
import sys
import threading
import time
import traceback

spec = importlib.util.spec_from_file_location('release_probe', Path(__file__).with_name('windows-clipboard-release.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
ROOT = p.ROOT
OUT = ROOT / 'evidence' / 'clipboard-contention'
OUT.mkdir(parents=True, exist_ok=True)
EXE = ROOT / 'artifacts' / 'clipboard-contention.exe'
REPORT = {'schema': 1, 'started': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
          'method': 'Physical browser copy menu; pre-armed persistent Rust release process; timer anchored at first clipboard sequence change. Independent reference reads only after the observation window.',
          'executableSha256': hashlib.sha256(EXE.read_bytes()).hexdigest(),
          'pilot': '--pilot' in sys.argv, 'tests': []}


def save():
    (OUT / 'results.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def qpc():
    ticks = ctypes.c_longlong()
    if not ctypes.windll.kernel32.QueryPerformanceCounter(ctypes.byref(ticks)):
        raise ctypes.WinError()
    return ticks.value


class Worker:
    def __init__(self):
        self.stderr = (OUT / 'probe-stderr.txt').open('w', encoding='utf-8')
        self.process = subprocess.Popen([str(EXE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, text=True, encoding='utf-8', bufsize=1)
        self.queue = queue.Queue()
        def receive():
            for line in self.process.stdout:
                try:
                    self.queue.put(json.loads(line))
                except Exception as error:
                    self.queue.put({'event': 'invalid-json', 'error': str(error), 'line': line})
            self.queue.put({'event': 'eof', 'exit': self.process.poll()})
        self.reader = threading.Thread(target=receive, daemon=True)
        self.reader.start()
        self.started = self.get('started')
        assert self.started['build']['profile'] == 'release'
        assert self.started['build']['optLevel'] == '3'
        assert not self.started['build']['debugAssertions']

    def get(self, event, timeout=20):
        value = self.queue.get(timeout=timeout)
        if value.get('event') != event:
            raise RuntimeError('Expected ' + event + ', got ' + repr(value))
        return value

    def arm(self, case, mode, delay, trigger='sequence'):
        self.process.stdin.write(json.dumps({'id': case, 'mode': mode, 'delayMs': delay, 'trigger': trigger}) + '\n')
        self.process.stdin.flush()
        return self.get('ready')

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.stderr.close()


def prepare_copy(cdp, hwnd, selector, browser_pid):
    p.win32gui.ShowWindow(hwnd, p.win32con.SW_RESTORE)
    left, top, right, bottom = p.win32gui.GetWindowRect(hwnd)
    p.click((left + 120, top + 15))
    time.sleep(.15)
    position = cdp.js('(()=>{const i=document.querySelector(' + json.dumps(selector) + ');const r=i.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,ow:outerWidth,oh:outerHeight,iw:innerWidth,ih:innerHeight,url:i.currentSrc}})()')
    scale = (right - left) / position['ow']
    border = (position['ow'] - position['iw']) / 2
    target = (round(left + (border + position['x']) * scale),
              round(top + (position['oh'] - position['ih'] - border + position['y']) * scale))
    assert p.win32gui.GetAncestor(p.win32gui.WindowFromPoint(target), 2) == hwnd
    p.click(target, right=True)
    time.sleep(.35)
    desktop = p.Desktop(backend='uia')
    candidates = []
    for window in desktop.windows():
        try:
            if window.element_info.control_type == 'Menu' or window.class_name() == 'Chrome_WidgetWin_0':
                candidates.extend(window.descendants(control_type='MenuItem'))
        except Exception:
            pass
    if not candidates:
        candidates = desktop.window(handle=hwnd).descendants(control_type='MenuItem')
    names = []
    for item in candidates:
        name = item.window_text()
        names.append(name)
        if re.search(r'copy image|复制(?:图片|图像)', name, re.I) and not re.search(r'address|link|地址|链接', name, re.I):
            rect = item.rectangle()
            point = (int((rect.left + rect.right) / 2), int((rect.top + rect.bottom) / 2))
            menu_window = p.win32gui.GetAncestor(p.win32gui.WindowFromPoint(point), 2)
            menu_pid = p.win32process.GetWindowThreadProcessId(menu_window)[1]
            assert menu_pid == browser_pid, (menu_pid, browser_pid)
            return point, {'name': name, 'sourceUrl': position['url'], 'sourcePoint': target,
                           'menuPoint': point, 'menuPid': menu_pid, 'targetWindowMatched': True}
    p.win32api.keybd_event(p.win32con.VK_ESCAPE, 0, 0, 0)
    p.win32api.keybd_event(p.win32con.VK_ESCAPE, 0, p.win32con.KEYEVENTF_KEYUP, 0)
    raise RuntimeError('Copy image menu not found: ' + repr(names))


def reference(expected):
    value = p.reference_png()
    value['sourceMatches'] = value['size'] == expected['size'] and value['rgba8Sha256'] in [expected['rgba8Sha256'], expected['fileRgba8Sha256']]
    return value


def cases(fixture, pilot):
    if pilot:
        delays = [0, 350, 1000, 3000] if fixture != 'small.jpg' else [0]
        repeats = 1
    else:
        delays = [0, 50, 150, 350, 700, 1500, 3000] if fixture != 'small.jpg' else [0]
        repeats = 3
    # Rotate order between repeats so long delays do not always come last.
    for repeat in range(1, repeats + 1):
        order = delays if repeat % 2 else list(reversed(delays))
        for delay in order:
            yield 'direct', delay, repeat
        if fixture != 'small.jpg':
            yield 'open-retry', 0, repeat
            yield 'observe', 0, repeat


class Server(socketserver.TCPServer):
    allow_reuse_address = True


def control_cases(worker):
    # Native lock control: helper owns the clipboard with a null HWND. This also
    # tests that a zero GetOpenClipboardWindow is not proof of an unlocked clipboard.
    helper = '''import ctypes,json,sys,time,win32clipboard,win32con
def qpc():
 v=ctypes.c_longlong();ctypes.windll.kernel32.QueryPerformanceCounter(ctypes.byref(v));return v.value
win32clipboard.OpenClipboard()
try:
 win32clipboard.EmptyClipboard()
 win32clipboard.SetClipboardText('RapidRAW:adjustments',win32con.CF_UNICODETEXT)
 print(json.dumps({'event':'holding','qpc':qpc()}),flush=True)
 time.sleep(int(sys.argv[1])/1000)
finally:
 win32clipboard.CloseClipboard()
 print(json.dumps({'event':'released','qpc':qpc()}),flush=True)
'''
    for hold_ms in [100, 350, 1000, 3500]:
        for mode in ['direct', 'open-retry']:
            case = f'generated-lock-{hold_ms}-{mode}'
            p.set_formats([(p.win32con.CF_UNICODETEXT, 'before lock')])
            ready = worker.arm(case, mode, 0)
            holder = subprocess.Popen([sys.executable, '-u', '-c', helper, str(hold_ms)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
            result = worker.get('result')
            stdout, stderr = holder.communicate(timeout=10)
            assert holder.returncode == 0, stderr
            row = {'case': case, 'generated': True, 'holdMs': hold_ms, 'mode': mode,
                   'holderPid': holder.pid, 'holderEvents': [json.loads(line) for line in stdout.splitlines()],
                   'holderStderr': stderr, 'ready': ready, 'result': result}
            REPORT.setdefault('controls', []).append(row)
            save()
            assert not result.get('error')
            if mode == 'open-retry':
                assert any(not x['ok'] and x['win32Code'] == 5 for x in result['openAttempts'])
                assert result['primary']['ok'] == (hold_ms < 3000)
            else:
                assert not result['primary']['ok']
            print(case, flush=True)
    for name, formats in [('marker', [(p.win32con.CF_UNICODETEXT, 'RapidRAW:adjustments')]), ('empty', [])]:
        p.set_formats(formats)
        case = 'generated-stable-' + name
        ready = worker.arm(case, 'direct', 0, trigger='immediate')
        result = worker.get('result')
        REPORT.setdefault('controls', []).append({'case': case, 'generated': True,
                                                 'ready': ready, 'result': result})
        save()
        assert not result['primary']['ok']
        assert result['openAttempts'][0]['ok']
        print(case, flush=True)


def main():
    session = ctypes.c_ulong()
    assert ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session))
    assert session.value != 0, 'Must use the logged-in desktop, not SSH Session 0'
    REPORT['sessionId'] = session.value
    desktop = ctypes.windll.user32.OpenInputDesktop(0, False, 0x0100)
    assert desktop, 'Input desktop locked/inaccessible'
    ctypes.windll.user32.CloseDesktop(desktop)
    fixtures = ['small.jpg', 'large.jpg', 'photo-control.jpg']
    REPORT['fixtures'] = [{'name': f, 'bytes': (p.FIX / f).stat().st_size,
                           'sha256': hashlib.sha256((p.FIX / f).read_bytes()).hexdigest()} for f in fixtures]
    if '--resume' in sys.argv:
        previous = json.loads((OUT / 'results.json').read_text(encoding='utf-8'))
        assert previous['executableSha256'] == REPORT['executableSha256']
        assert previous['fixtures'] == REPORT['fixtures']
        assert previous['pilot'] == REPORT['pilot']
        assert all(t.get('inputVerified') for t in previous['tests'])
        assert len({t['case'] for t in previous['tests']}) == len(previous['tests'])
        if previous.get('fatalError'):
            previous.setdefault('driverFailures', []).append(previous.pop('fatalError'))
        REPORT.clear()
        REPORT.update(previous)
    done = {t['case'] for t in REPORT['tests']}
    (p.FIX / 'clipboard-contention.html').write_text('<!doctype html><meta charset="utf-8"><title>RapidRAW clipboard contention</title>' + ''.join(f'<span style="display:inline-block"><p>{f}</p><img id="f{i}" src="{f}" width="180"></span>' for i, f in enumerate(fixtures)), encoding='utf-8')
    server = Server(('127.0.0.1', 8769), p.functools.partial(p.Handler, directory=str(p.FIX)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    worker = Worker()
    if 'probe' in REPORT:
        assert REPORT['probe']['qpcFrequency'] == worker.started['qpcFrequency']
    else:
        REPORT['probe'] = worker.started
    REPORT['sourceBase'] = '3b5df34f plus contention probe working tree'
    source_hashes = {str(f.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(f.read_bytes()).hexdigest() for f in [Path(__file__), ROOT / 'spike/intake/scripts/windows-clipboard-release.py', ROOT / 'spike/intake/src-tauri/examples/clipboard_contention.rs', ROOT / 'spike/intake/src-tauri/Cargo.toml', ROOT / 'spike/intake/src-tauri/Cargo.lock']}
    REPORT.setdefault('sourceHashes', source_hashes)
    REPORT.setdefault('runs', []).append({'probe': worker.started, 'started': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'sourceHashes': source_hashes})
    save()
    try:
        for browser, path, port in [('Chrome', r'C:\Program Files\Google\Chrome\Application\chrome.exe', 9363), ('Edge', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 9365)]:
            expected_browser_cases = {f'{browser}-{fixture}-{mode}-{delay}-{repeat}' for fixture in fixtures for mode, delay, repeat in cases(fixture, REPORT['pilot'])}
            if expected_browser_cases <= done:
                continue
            process = subprocess.Popen([path, '--user-data-dir=' + str(ROOT / 'profiles' / ('contention-' + browser.lower() + '-run' + str(len(REPORT['runs'])))), '--no-first-run', '--no-default-browser-check', '--force-renderer-accessibility', '--remote-debugging-port=' + str(port), '--new-window', 'http://127.0.0.1:8769/clipboard-contention.html'])
            cdp = None
            try:
                cdp = p.CDP(port)
                deadline = time.monotonic() + 30
                while not cdp.js('document.images.length===3 && [...document.images].every(i=>i.complete&&i.naturalWidth>0)'):
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Source images not ready')
                    time.sleep(.1)
                REPORT.setdefault('browsers', {})[browser] = cdp.meta
                hwnd = p.hwnd_for(process.pid)
                p.win32gui.MoveWindow(hwnd, 10, 30, min(1250, p.win32api.GetSystemMetrics(0)-20), min(850, p.win32api.GetSystemMetrics(1)-60), True)
                for index, fixture in enumerate(fixtures):
                    expected = p.source_pixels(cdp, '#f' + str(index), fixture)
                    for mode, delay, repeat in cases(fixture, REPORT['pilot']):
                        case = f'{browser}-{fixture}-{mode}-{delay}-{repeat}'
                        if case in done:
                            continue
                        # Controlled previous clipboard marker; no actual editor adjustments are applied.
                        p.set_formats([(p.win32con.CF_UNICODETEXT, 'RapidRAW:adjustments')])
                        # Keep CDP connections short lived. Earlier Edge sessions aborted a
                        # long-lived socket between samples; no CDP is needed during the read.
                        try:
                            cdp.ws.close(timeout=1)
                        except Exception:
                            pass
                        cdp = p.CDP(port)
                        for attempt in range(1, 4):
                            try:
                                point, menu = prepare_copy(cdp, hwnd, '#f' + str(index), process.pid)
                                break
                            except RuntimeError as error:
                                REPORT.setdefault('driverRetries', []).append({'case': case, 'attempt': attempt, 'error': str(error)})
                                save()
                                if attempt == 3:
                                    raise
                                time.sleep(.3)
                        ready = worker.arm(case, mode, delay)
                        p.win32api.SetCursorPos(point)
                        p.win32api.mouse_event(p.win32con.MOUSEEVENTF_LEFTDOWN, 0, 0)
                        time.sleep(.04)
                        menu['mouseUpBeforeQpc'] = qpc()
                        p.win32api.mouse_event(p.win32con.MOUSEEVENTF_LEFTUP, 0, 0)
                        menu['mouseUpAfterQpc'] = qpc()
                        result = worker.get('result')
                        row = {'case': case, 'browser': browser, 'fixture': fixture, 'mode': mode,
                               'delayMs': delay, 'repeat': repeat, 'menu': menu, 'ready': ready,
                               'sourcePixels': expected, 'result': result, 'probePid': worker.started['pid']}
                        REPORT['tests'].append(row)
                        save()
                        if result.get('error'):
                            raise RuntimeError(result['error'])
                        ref = reference(expected)
                        row['reference'] = ref
                        row['inputVerified'] = ref['sourceMatches'] and ref['threeReadsByteEqual']
                        png = result.get('png')
                        if png:
                            row['payloadMatchesSource'] = png['ok'] and [png['width'], png['height']] == expected['size'] and png['rgba8Sha256'] in [expected['rgba8Sha256'], expected['fileRgba8Sha256']]
                            row['bytesMatchLateReference'] = png.get('sha256') == ref['sha256']
                        row['lateSequenceMatches'] = result['endSequence'] == ref['sequences'][0]
                        save()
                        assert row['inputVerified'], case + ': clipboard does not match copied source'
                        print(case, 'read=' + str(result['primary'].get('ok') if result['primary'] else None), flush=True)
                cdp.call('Browser.close')
                process.wait(timeout=15)
            finally:
                if cdp:
                    cdp.ws.close()
                if process.poll() is None:
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=15)
        expected_count = 26 if REPORT['pilot'] else 114
        assert len(REPORT['tests']) == expected_count
        expected_cases = {f'{browser}-{fixture}-{mode}-{delay}-{repeat}' for browser in ['Chrome', 'Edge'] for fixture in fixtures for mode, delay, repeat in cases(fixture, REPORT['pilot'])}
        assert {t['case'] for t in REPORT['tests']} == expected_cases
        assert all(t.get('inputVerified') for t in REPORT['tests'])
        control_cases(worker)
        assert len(REPORT['controls']) == 10
        REPORT['completed'] = True
        REPORT['finished'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        save()
    finally:
        worker.close()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        REPORT['fatalError'] = traceback.format_exc()
        REPORT['completed'] = False
        save()
        raise
