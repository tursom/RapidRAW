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
DISPATCH = '--dispatch' in sys.argv
OUT = ROOT / 'evidence' / ('clipboard-dispatch' if DISPATCH else 'clipboard-contention')
OUT.mkdir(parents=True, exist_ok=True)
EXE = ROOT / 'artifacts' / ('clipboard-contention-dispatch.exe' if DISPATCH else 'clipboard-contention.exe')
REPORT = {'schema': 1, 'started': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
          'method': 'Physical browser copy menu; pre-armed persistent Rust release process; anchor=' + ('go sent immediately after mouse release' if DISPATCH else 'first observed clipboard sequence change') + '. Independent reference reads only after the observation window.',
          'executableSha256': hashlib.sha256(EXE.read_bytes()).hexdigest(),
          'pilot': '--pilot' in sys.argv, 'dispatchAnchor': DISPATCH, 'tests': []}
OUTPUT_NAME = 'resume-rejected.json' if '--resume' in sys.argv else 'results.json'


def save():
    (OUT / OUTPUT_NAME).write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def qpc():
    ticks = ctypes.c_longlong()
    if not ctypes.windll.kernel32.QueryPerformanceCounter(ctypes.byref(ticks)):
        raise ctypes.WinError()
    return ticks.value


class SourceCDP(p.CDP):
    """Select our fixture tab, including after Edge opens an unrelated welcome tab."""
    def __init__(self, port):
        deadline = time.monotonic() + 40
        while True:
            try:
                items = json.load(p.urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=2))
                page = next(x for x in items if x.get('type') == 'page' and x.get('url') == 'http://127.0.0.1:8769/clipboard-contention.html')
                self.ws = p.websocket.create_connection(page['webSocketDebuggerUrl'], timeout=30, suppress_origin=True)
                self.seq = 0
                self.meta = json.load(p.urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=2))
                root_socket = p.websocket.create_connection(self.meta['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)
                try:
                    root_socket.send(json.dumps({'id': 1, 'method': 'SystemInfo.getProcessInfo'}))
                    while True:
                        response = json.loads(root_socket.recv())
                        if response.get('id') == 1:
                            self.browser_pid = int(next(x['id'] for x in response['result']['processInfo'] if x['type'] == 'browser'))
                            self.meta['browserPid'] = self.browser_pid
                            break
                finally:
                    root_socket.close()
                self.call('Page.bringToFront')
                return
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.2)


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

    def arm(self, case, mode, delay, trigger='sequence', capture_text=False):
        self.process.stdin.write(json.dumps({'id': case, 'mode': mode, 'delayMs': delay, 'trigger': trigger, 'captureTextAfterFailure': capture_text}) + '\n')
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


def source_window(browser_pid):
    deadline = time.monotonic() + 5
    while True:
        matches = []
        def visit(hwnd, _):
            if (p.win32process.GetWindowThreadProcessId(hwnd)[1] == browser_pid
                    and p.win32gui.IsWindowVisible(hwnd)
                    and p.win32gui.GetWindowText(hwnd).startswith('RapidRAW clipboard contention')):
                matches.append(hwnd)
        p.win32gui.EnumWindows(visit, None)
        if matches:
            return matches[0]
        if time.monotonic() >= deadline:
            raise RuntimeError('Fixture browser window not found for CDP browser PID ' + str(browser_pid))
        time.sleep(.1)


def prepare_copy(cdp, hwnd, selector, browser_pid):
    p.win32gui.ShowWindow(hwnd, p.win32con.SW_RESTORE)
    p.win32gui.SetWindowPos(hwnd, p.win32con.HWND_TOPMOST, 10, 30,
                           min(1250, p.win32api.GetSystemMetrics(0)-20),
                           min(850, p.win32api.GetSystemMetrics(1)-60), p.win32con.SWP_SHOWWINDOW)
    left, top, right, bottom = p.win32gui.GetWindowRect(hwnd)
    cdp.call('Page.bringToFront')
    position = cdp.js('(()=>{const i=document.querySelector(' + json.dumps(selector) + ');const r=i.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,ow:outerWidth,oh:outerHeight,iw:innerWidth,ih:innerHeight,url:i.currentSrc}})()')
    scale = (right - left) / position['ow']
    border = (position['ow'] - position['iw']) / 2
    target = (round(left + (border + position['x']) * scale),
              round(top + (position['oh'] - position['ih'] - border + position['y']) * scale))
    # Target the verified fixture tab, avoiding unrelated first-run Edge UI.
    # CDP input opens the real browser menu; only menu selection triggers copying.
    cdp.js("window.__intakeContext=null;document.oncontextmenu=e=>window.__intakeContext={trusted:e.isTrusted,id:e.target.id,url:e.target.currentSrc}")
    for kind in ['mousePressed', 'mouseReleased']:
        cdp.call('Input.dispatchMouseEvent', {'type': kind, 'x': position['x'], 'y': position['y'], 'button': 'right', 'clickCount': 1})
    context = cdp.js('window.__intakeContext')
    assert context and context['trusted'] and context['id'] == selector.removeprefix('#') and context['url'] == position['url']
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
                           'menuPoint': point, 'menuPid': menu_pid, 'contextMenuEvent': context,
                           'sourceInput': 'CDP trusted context-menu input; physical Win32 menu selection'}
    p.win32api.keybd_event(p.win32con.VK_ESCAPE, 0, 0, 0)
    p.win32api.keybd_event(p.win32con.VK_ESCAPE, 0, p.win32con.KEYEVENTF_KEYUP, 0)
    raise RuntimeError('Copy image menu not found: ' + repr(names))


def reference(expected):
    value = p.reference_png()
    value['sourceMatches'] = value['size'] == expected['size'] and value['rgba8Sha256'] in [expected['rgba8Sha256'], expected['fileRgba8Sha256']]
    return value


def cases(fixture, pilot, dispatch=False):
    if dispatch:
        delays = [0, 200, 350, 700] if fixture != 'small.jpg' else [0]
        repeats = 1 if pilot else 3
    elif pilot:
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
        if fixture != 'small.jpg' and not dispatch:
            yield 'open-retry', 0, repeat
            yield 'observe', 0, repeat


class Server(socketserver.TCPServer):
    allow_reuse_address = True


def validate_control(row, frequency):
    result = row['result']
    assert not result.get('error')
    if 'holdMs' not in row:
        assert not result['primary']['ok'] and result['openAttempts'][0]['ok']
        return
    assert row.get('holderExitCode', 0) == 0 and len(row['holderEvents']) == 2, 'holder did not complete open/release'
    held, released = row['holderEvents']
    read = result['readQpc']
    assert held.get('openedQpc', held['qpc']) <= read < released['qpc'], 'reader did not start during held interval'
    row['readBeganDuringHold'] = True
    if row['mode'] == 'open-retry':
        assert any(not x['ok'] and x['win32Code'] == 5 for x in result['openAttempts'])
        assert result['primary']['ok'] == (row['holdMs'] < 3000)
    else:
        assert not result['primary']['ok']
        end_qpc = result['originQpc'] + result['primary']['endMs'] * frequency / 1000
        row['readEndedBeforeRelease'] = end_qpc < released['qpc']


def control_cases(worker):
    # Use a real hidden HWND. OpenClipboard(NULL) is unsuitable for this control:
    # other null-window callers can interfere with its ownership/close lifecycle.
    helper = '''import ctypes,json,sys,time,win32clipboard,win32con,win32gui
def qpc():
 v=ctypes.c_longlong();ctypes.windll.kernel32.QueryPerformanceCounter(ctypes.byref(v));return v.value
hwnd=win32gui.CreateWindowEx(0,'STATIC','RapidRAW clipboard lock control',0,0,0,1,1,0,0,0,None)
win32clipboard.OpenClipboard(hwnd)
opened=qpc()
try:
 win32clipboard.EmptyClipboard()
 win32clipboard.SetClipboardText('RapidRAW:adjustments',win32con.CF_UNICODETEXT)
 print(json.dumps({'event':'holding','qpc':qpc(),'openedQpc':opened,'hwnd':hwnd}),flush=True)
 time.sleep(int(sys.argv[1])/1000)
finally:
 win32clipboard.CloseClipboard()
 print(json.dumps({'event':'released','qpc':qpc()}),flush=True)
 win32gui.DestroyWindow(hwnd)
'''
    frequency = worker.started['qpcFrequency']
    reusable = set()
    for previous in list(REPORT.get('controls', [])):
        try:
            validate_control(previous, frequency)
            previous['verified'] = True
            reusable.add(previous['case'])
        except AssertionError as error:
            REPORT.setdefault('discardedControls', []).append({'reason': str(error), 'record': previous})
            REPORT['controls'].remove(previous)
    for hold_ms in [100, 350, 1000, 3500]:
        for mode in ['direct', 'open-retry']:
            case = f'generated-lock-{hold_ms}-{mode}'
            if case in reusable:
                continue
            p.set_formats([(p.win32con.CF_UNICODETEXT, 'before lock')])
            ready = worker.arm(case, mode, 0)
            holder = subprocess.Popen([sys.executable, '-X', 'utf8', '-u', '-c', helper, str(hold_ms)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
            result = worker.get('result')
            stdout, stderr = holder.communicate(timeout=10)
            exit_code = holder.wait(timeout=10)
            row = {'case': case, 'generated': True, 'holdMs': hold_ms, 'mode': mode,
                   'holderPid': holder.pid, 'holderExitCode': exit_code,
                   'holderEvents': [json.loads(line) for line in (stdout or '').splitlines()],
                   'holderStderr': stderr, 'ready': ready, 'result': result}
            REPORT.setdefault('controls', []).append(row)
            save()
            assert exit_code == 0, stderr
            assert len(row['holderEvents']) == 2, 'holder did not report open/release'
            validate_control(row, frequency)
            row['verified'] = True
            save()
            print(case, flush=True)
    for name, formats in [('marker', [(p.win32con.CF_UNICODETEXT, 'RapidRAW:adjustments')]), ('empty', [])]:
        p.set_formats(formats)
        case = 'generated-stable-' + name
        if case in reusable:
            continue
        ready = worker.arm(case, 'direct', 0, trigger='immediate')
        result = worker.get('result')
        row = {'case': case, 'generated': True, 'ready': ready, 'result': result}
        REPORT.setdefault('controls', []).append(row)
        save()
        validate_control(row, frequency)
        row['verified'] = True
        save()
        print(case, flush=True)


def main():
    global OUTPUT_NAME
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
        assert previous.get('dispatchAnchor', False) == DISPATCH
        pending = [t for t in previous['tests'] if not t.get('inputVerified')]
        previous['tests'] = [t for t in previous['tests'] if t.get('inputVerified')]
        previous.setdefault('discardedAttempts', []).extend(pending)
        assert len({t['case'] for t in previous['tests']}) == len(previous['tests'])
        if previous.get('fatalError'):
            previous.setdefault('driverFailures', []).append(previous.pop('fatalError'))
        REPORT.clear()
        REPORT.update(previous)
        OUTPUT_NAME = 'results.json'
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
            expected_browser_cases = {f'{browser}-{fixture}-{mode}-{delay}-{repeat}' for fixture in fixtures for mode, delay, repeat in cases(fixture, REPORT['pilot'], DISPATCH)}
            if expected_browser_cases <= done:
                continue
            profile = 'contention-' + ('dispatch-' if DISPATCH else '') + browser.lower() + '-run' + str(len(REPORT['runs']))
            process = subprocess.Popen([path, '--user-data-dir=' + str(ROOT / 'profiles' / profile), '--no-first-run', '--no-default-browser-check', '--force-renderer-accessibility', '--remote-debugging-port=' + str(port), '--new-window', 'http://127.0.0.1:8769/clipboard-contention.html'])
            cdp = None
            try:
                cdp = SourceCDP(port)
                deadline = time.monotonic() + 30
                while not cdp.js('document.images.length===3 && [...document.images].every(i=>i.complete&&i.naturalWidth>0)'):
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Source images not ready')
                    time.sleep(.1)
                REPORT.setdefault('browsers', {})[browser] = cdp.meta
                hwnd = source_window(cdp.browser_pid)
                p.win32gui.MoveWindow(hwnd, 10, 30, min(1250, p.win32api.GetSystemMetrics(0)-20), min(850, p.win32api.GetSystemMetrics(1)-60), True)
                for index, fixture in enumerate(fixtures):
                    expected = p.source_pixels(cdp, '#f' + str(index), fixture)
                    for mode, delay, repeat in cases(fixture, REPORT['pilot'], DISPATCH):
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
                        cdp = SourceCDP(port)
                        for attempt in range(1, 4):
                            try:
                                hwnd = source_window(cdp.browser_pid)
                                point, menu = prepare_copy(cdp, hwnd, '#f' + str(index), cdp.browser_pid)
                                break
                            except RuntimeError as error:
                                REPORT.setdefault('driverRetries', []).append({'case': case, 'attempt': attempt, 'error': str(error)})
                                save()
                                if attempt == 3:
                                    raise
                                time.sleep(.3)
                        ready = worker.arm(case, mode, delay, trigger='external' if DISPATCH else 'sequence', capture_text=DISPATCH)
                        p.win32api.SetCursorPos(point)
                        p.win32api.mouse_event(p.win32con.MOUSEEVENTF_LEFTDOWN, 0, 0)
                        time.sleep(.04)
                        menu['mouseUpBeforeQpc'] = qpc()
                        p.win32api.mouse_event(p.win32con.MOUSEEVENTF_LEFTUP, 0, 0)
                        menu['mouseUpAfterQpc'] = qpc()
                        if DISPATCH:
                            worker.process.stdin.write('go\n')
                            worker.process.stdin.flush()
                            menu['goSentQpc'] = qpc()
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
                    try:
                        cdp.call('Browser.close')
                    except Exception:
                        pass
                    cdp.ws.close()
                if process.poll() is None:
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=15)
        expected_count = (18 if REPORT['pilot'] else 54) if DISPATCH else (26 if REPORT['pilot'] else 114)
        assert len(REPORT['tests']) == expected_count
        expected_cases = {f'{browser}-{fixture}-{mode}-{delay}-{repeat}' for browser in ['Chrome', 'Edge'] for fixture in fixtures for mode, delay, repeat in cases(fixture, REPORT['pilot'], DISPATCH)}
        assert {t['case'] for t in REPORT['tests']} == expected_cases
        assert all(t.get('inputVerified') for t in REPORT['tests'])
        if not DISPATCH:
            control_cases(worker)
            assert len(REPORT['controls']) == 10
            expected_controls = {f'generated-lock-{hold}-{mode}' for hold in [100, 350, 1000, 3500] for mode in ['direct', 'open-retry']} | {'generated-stable-marker', 'generated-stable-empty'}
            assert {t['case'] for t in REPORT['controls']} == expected_controls
            assert all(t.get('verified') for t in REPORT['controls'])
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
