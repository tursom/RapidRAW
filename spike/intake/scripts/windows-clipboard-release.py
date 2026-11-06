"""Run in the logged-in Windows desktop with the spike's isolated Python venv.
Build artifacts/clipboard-release.exe first; see ../evidence/windows/release/README.md.
Only opens/closes dedicated browser profiles. Does not drive Explorer or import files.
"""
import ctypes
import functools
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import re
import socketserver
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.request

from PIL import Image, ImageOps
from pywinauto import Desktop
import websocket
import win32api
import win32clipboard
import win32con
import win32gui
import win32process

ctypes.windll.user32.SetProcessDPIAware()
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'evidence' / 'clipboard-release'
OUT.mkdir(parents=True, exist_ok=True)
FIX = ROOT / 'fixtures'
EXE = ROOT / 'artifacts' / 'clipboard-release.exe'
REPORT = {
    'schema': 1, 'started': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    'method': 'Interactive Windows Session 1; physical browser context-menu copy; fresh release CLI per read. Local fixture server, not real-website drag coverage.',
    'executableSha256': hashlib.sha256(EXE.read_bytes()).hexdigest(),
    'tests': [],
}


def save():
    (OUT / 'results.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding='utf-8')


def note(case, **data):
    REPORT['tests'].append({'case': case, **data})
    save()
    print(case, flush=True)


class CDP:
    def __init__(self, port):
        deadline = time.time() + 40
        while True:
            try:
                items = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=2))
                page = next(x for x in items if x.get('type') == 'page')
                self.ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=30, suppress_origin=True)
                self.seq = 0
                self.meta = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=2))
                return
            except Exception:
                if time.time() > deadline:
                    raise
                time.sleep(.3)

    def call(self, method, params=None):
        self.seq += 1
        self.ws.send(json.dumps({'id': self.seq, 'method': method, 'params': params or {}}))
        while True:
            value = json.loads(self.ws.recv())
            if value.get('id') == self.seq:
                if 'error' in value:
                    raise RuntimeError(value['error'])
                return value.get('result', {})

    def js(self, text):
        value = self.call('Runtime.evaluate', {'expression': text, 'returnByValue': True, 'awaitPromise': True})
        if value.get('exceptionDetails'):
            raise RuntimeError(value['exceptionDetails'])
        return value.get('result', {}).get('value')


def click(point, right=False):
    win32api.SetCursorPos(point)
    down, up = (win32con.MOUSEEVENTF_RIGHTDOWN, win32con.MOUSEEVENTF_RIGHTUP) if right else (win32con.MOUSEEVENTF_LEFTDOWN, win32con.MOUSEEVENTF_LEFTUP)
    win32api.mouse_event(down, 0, 0)
    time.sleep(.08)
    win32api.mouse_event(up, 0, 0)


def hwnd_for(pid):
    windows = []
    def visit(hwnd, _):
        if win32process.GetWindowThreadProcessId(hwnd)[1] == pid and win32gui.IsWindowVisible(hwnd):
            windows.append(hwnd)
    win32gui.EnumWindows(visit, None)
    return max(windows, key=lambda h: (win32gui.GetWindowRect(h)[2] - win32gui.GetWindowRect(h)[0]) * (win32gui.GetWindowRect(h)[3] - win32gui.GetWindowRect(h)[1]))


def copy_image(cdp, hwnd, selector):
    before = ctypes.windll.user32.GetClipboardSequenceNumber()
    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    click((left + 120, top + 15))
    time.sleep(.2)
    m = cdp.js('(()=>{const r=document.querySelector(' + json.dumps(selector) + ').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,ow:outerWidth,oh:outerHeight,iw:innerWidth,ih:innerHeight}})()')
    scale = (right - left) / m['ow']
    border = (m['ow'] - m['iw']) / 2
    click((round(left + (border + m['x']) * scale), round(top + (m['oh'] - m['ih'] - border + m['y']) * scale)), right=True)
    time.sleep(.5)
    candidates = []
    desktop = Desktop(backend='uia')
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
            item.click_input()
            time.sleep(.35)
            deadline = time.monotonic() + 3
            while ctypes.windll.user32.GetClipboardSequenceNumber() == before:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Copy image did not change clipboard sequence')
                time.sleep(.02)
            return {'name': name, 'sequenceBefore': before, 'sequenceAfter': ctypes.windll.user32.GetClipboardSequenceNumber()}
    win32api.keybd_event(win32con.VK_ESCAPE, 0, 0, 0)
    win32api.keybd_event(win32con.VK_ESCAPE, 0, win32con.KEYEVENTF_KEYUP, 0)
    raise RuntimeError('Copy image menu missing: ' + repr(names))


def run_probe(mode):
    sequence_before = ctypes.windll.user32.GetClipboardSequenceNumber()
    started = time.perf_counter()
    process = subprocess.run([str(EXE), mode], capture_output=True, text=True, encoding='utf-8', timeout=90)
    wall_ms = (time.perf_counter() - started) * 1000
    if process.returncode:
        raise RuntimeError(process.stderr)
    value = json.loads(process.stdout)
    assert value['build']['profile'] == 'release' and value['build']['optLevel'] == '3'
    assert not value['build']['debugAssertions']
    return {'result': value, 'processWallMs': wall_ms, 'sequenceBefore': sequence_before,
            'sequenceAfter': ctypes.windll.user32.GetClipboardSequenceNumber(), 'stderr': process.stderr}


def reference_png():
    # Read AFTER the timed Rust probe, so this does not pre-render its first read.
    buffers = []
    sequences = []
    for _ in range(3):
        open_clipboard()
        try:
            buffers.append(win32clipboard.GetClipboardData(win32clipboard.RegisterClipboardFormat('PNG')))
            sequences.append(ctypes.windll.user32.GetClipboardSequenceNumber())
        finally:
            win32clipboard.CloseClipboard()
    image = Image.open(io.BytesIO(buffers[0])).convert('RGBA')
    return {'bytes': len(buffers[0]), 'sha256': hashlib.sha256(buffers[0]).hexdigest(),
            'rgba8Sha256': hashlib.sha256(image.tobytes()).hexdigest(), 'size': list(image.size),
            'threeReadsByteEqual': buffers[0] == buffers[1] == buffers[2], 'sequences': sequences}


def source_pixels(cdp, selector, fixture):
    result = cdp.js('''(async () => {
        const image = document.querySelector(''' + json.dumps(selector) + ''');
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
        return {size: [canvas.width, canvas.height], url: image.currentSrc,
            rgba8Sha256: [...hash].map(x => x.toString(16).padStart(2, '0')).join(''),
            method: 'source browser canvas rendered RGBA8, before clipboard copy'};
    })()''')
    source = Image.open(FIX / fixture).convert('RGBA')
    assert list(source.size) == result['size']
    result['fileRgba8Sha256'] = hashlib.sha256(source.tobytes()).hexdigest()
    result['fileSha256'] = hashlib.sha256((FIX / fixture).read_bytes()).hexdigest()
    return result


def verify(value, ref, mode, source):
    assert value['imageMode'] == mode
    assert ref['size'] == source['size']
    assert ref['rgba8Sha256'] in [source['rgba8Sha256'], source['fileRgba8Sha256']]
    assert len(set(ref['sequences'])) == 1
    raw = value.get('rawPng')
    old = value.get('image')
    if mode == 'reencode':
        assert raw is None and old['ok'] and old['value']['png']['ok']
        assert value['selected']['method'] == 'decoded-reencoded'
    else:
        assert raw['ok'] and value['selected']['method'] == 'raw-png'
        if mode == 'prefer-png':
            assert old is None
        else:
            assert mode == 'compare' and old['ok'] and old['value']['png']['ok']
            assert value['sameRgba8'] is True
    if raw and raw['ok']:
        assert raw['value']['sha256'] == ref['sha256']
        assert raw['value']['rgba8Sha256'] == ref['rgba8Sha256']
        assert [raw['value']['width'], raw['value']['height']] == ref['size']
    if old and old['ok']:
        assert old['value']['rgba8Sha256'] == ref['rgba8Sha256']
        assert [old['value']['width'], old['value']['height']] == ref['size']
    assert ref['threeReadsByteEqual']
    assert value['selected'] is not None


def open_clipboard():
    deadline = time.monotonic() + 3
    retries = 0
    while True:
        try:
            win32clipboard.OpenClipboard()
            if retries:
                REPORT.setdefault('referenceOpenRetries', []).append(retries)
            return
        except Exception:
            if time.monotonic() >= deadline:
                raise
            retries += 1
            time.sleep(.02)


def set_formats(formats):
    open_clipboard()
    try:
        win32clipboard.EmptyClipboard()
        for fmt, data in formats:
            win32clipboard.SetClipboardData(fmt, data)
    finally:
        win32clipboard.CloseClipboard()


def dibv5(bitfields=True):
    header = bytearray(124)
    # Top-down 2x1 BGRA, red opaque and blue/green partially transparent.
    pixels = bytes([0, 0, 255, 255, 255, 128, 0, 64])
    struct.pack_into('<IiiHHIIiiII', header, 0, 124, 2, -1, 1, 32, 3 if bitfields else 0, len(pixels), 0, 0, 0, 0)
    if bitfields:
        struct.pack_into('<IIII', header, 40, 0xff0000, 0xff00, 0xff, 0xff000000)
    struct.pack_into('<I', header, 56, 0x73524742)
    return bytes(header) + pixels


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    session = ctypes.c_ulong()
    if not ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
        raise ctypes.WinError()
    if session.value == 0:
        raise RuntimeError('Must run in logged-in desktop, not SSH Session 0')
    desktop = ctypes.windll.user32.OpenInputDesktop(0, False, 0x0100)
    if not desktop:
        raise RuntimeError('Input desktop inaccessible')
    ctypes.windll.user32.CloseDesktop(desktop)
    REPORT['sessionId'] = session.value
    REPORT['screen'] = [win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1)]
    photo_source = ROOT / 'public' / 'splash-light.jpg'
    REPORT['photoSource'] = {'path': 'public/splash-light.jpg', 'sha256': hashlib.sha256(photo_source.read_bytes()).hexdigest(), 'originalSize': [2048, 2048], 'transform': 'ImageOps.fit to 6000x4000 with LANCZOS, JPEG quality92. Upscaled control, not a native 24MP photo.'}
    photo = ImageOps.fit(Image.open(photo_source).convert('RGB'), (6000, 4000), method=Image.Resampling.LANCZOS)
    photo.save(FIX / 'photo-control.jpg', quality=92)
    # Additional local format smoke cases; these do not count as remote website coverage.
    transparent = Image.new('RGBA', (1024, 768), (20, 180, 100, 96))
    transparent.save(FIX / 'transparent.png')
    Image.open(photo_source).save(FIX / 'photo-control.webp', quality=85)
    fixtures = ['small.jpg', 'large.jpg', 'photo-control.jpg', 'transparent.png', 'photo-control.webp']
    REPORT['fixtures'] = [{'name': name, 'bytes': (FIX / name).stat().st_size, 'sha256': hashlib.sha256((FIX / name).read_bytes()).hexdigest(), 'size': list(Image.open(FIX / name).size)} for name in fixtures]
    (FIX / 'clipboard-release.html').write_text('<!doctype html><meta charset="utf-8"><title>RapidRAW clipboard release fixture</title>' + ''.join(f'<span style="display:inline-block"><p>{name}</p><img id="f{i}" src="{name}" width="160"></span>' for i, name in enumerate(fixtures)), encoding='utf-8')
    server = socketserver.TCPServer(('127.0.0.1', 8767), functools.partial(Handler, directory=str(FIX)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        for browser, path, port in [('Chrome', r'C:\Program Files\Google\Chrome\Application\chrome.exe', 9343), ('Edge', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 9345)]:
            process = subprocess.Popen([path, '--user-data-dir=' + str(ROOT / 'profiles' / ('release-' + browser.lower())), '--no-first-run', '--no-default-browser-check', '--force-renderer-accessibility', '--remote-debugging-port=' + str(port), '--new-window', 'http://127.0.0.1:8767/clipboard-release.html'])
            cdp = None
            try:
                cdp = CDP(port)
                deadline = time.time() + 30
                while not cdp.js('document.images.length===5 && [...document.images].every(i=>i.complete&&i.naturalWidth>0)'):
                    if time.time() > deadline:
                        raise TimeoutError('Fixture images not ready')
                    time.sleep(.2)
                REPORT.setdefault('browsers', {})[browser] = cdp.meta
                hwnd = hwnd_for(process.pid)
                win32gui.MoveWindow(hwnd, 10, 30, min(1250, REPORT['screen'][0]-20), min(850, REPORT['screen'][1]-60), True)
                for index, fixture in enumerate(fixtures):
                    expected = source_pixels(cdp, '#f' + str(index), fixture)
                    repeat_count = 3 if index < 3 else 1
                    for repeat in range(1, repeat_count + 1):
                        modes = ['prefer-png', 'reencode'] if repeat % 2 else ['reencode', 'prefer-png']
                        if repeat == 1:
                            modes.append('compare')
                        for mode in modes:
                            for attempt in range(1, 4):
                                try:
                                    menu = copy_image(cdp, hwnd, '#f' + str(index))
                                    break
                                except RuntimeError as error:
                                    REPORT.setdefault('driverRetries', []).append({
                                        'browser': browser, 'fixture': fixture, 'repeat': repeat,
                                        'mode': mode, 'attempt': attempt, 'error': str(error),
                                    })
                                    save()
                                    if attempt == 3:
                                        raise
                                    time.sleep(.5)
                            sample = run_probe(mode)
                            ref = reference_png()
                            note(f'{browser}-{fixture}-{repeat}-{mode}', browser=browser, fixture=fixture, repeat=repeat, mode=mode, menu=menu, sourcePixels=expected, reference=ref, verified=False, **sample)
                            verify(sample['result'], ref, mode, expected)
                            assert sample['sequenceAfter'] == ref['sequences'][0]
                            REPORT['tests'][-1]['verified'] = True
                            save()
                cdp.call('Browser.close')
                process.wait(timeout=15)
            finally:
                if cdp:
                    cdp.ws.close()
                if process.poll() is None:
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=15)
        assert browser_cases_complete(REPORT)
        REPORT['browserComplete'] = True
        save()
        generated_cases()
    finally:
        server.shutdown()
        server.server_close()


def browser_cases_complete(report):
    names = set()
    for browser in ['Chrome', 'Edge']:
        for index, fixture in enumerate(['small.jpg', 'large.jpg', 'photo-control.jpg', 'transparent.png', 'photo-control.webp']):
            for repeat in range(1, (3 if index < 3 else 1) + 1):
                for mode in ['prefer-png', 'reencode'] + (['compare'] if repeat == 1 else []):
                    names.add(f'{browser}-{fixture}-{repeat}-{mode}')
    rows = [t for t in report['tests'] if not t.get('generated')]
    return len(rows) == 54 and {t['case'] for t in rows} == names and all(t.get('verified') for t in rows)


def generated_cases():
    png = win32clipboard.RegisterClipboardFormat('PNG')
    cases = [('DIBV5-BI_RGB-only', [(win32con.CF_DIBV5, dibv5(False))]),
             ('DIBV5-BI_BITFIELDS-only', [(win32con.CF_DIBV5, dibv5())]),
             ('truncated-PNG', [(png, b'\x89PNG\r\n\x1a\n')]),
             ('mislabeled-JPEG', [(png, (FIX / 'small.jpg').read_bytes())]),
             ('corrupt-PNG-with-DIBV5', [(png, b'not a PNG'), (win32con.CF_DIBV5, dibv5(False))]),
             ('marker', [(win32con.CF_UNICODETEXT, 'RapidRAW:adjustments')]),
             ('empty', [])]
    for name, formats in cases:
        fixture = None
        for fmt, data in formats:
            if fmt == win32con.CF_DIBV5:
                bmp = b'BM' + struct.pack('<IHHI', 14 + len(data), 0, 0, 138) + data
                rgb = Image.open(io.BytesIO(bmp)).convert('RGB')
                assert list(rgb.getdata()) == [(255, 0, 0), (0, 128, 255)]
                fixture = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'PillowRgb': list(rgb.getdata())}
        set_formats(formats)
        sample = run_probe('prefer-png')
        value = sample['result']
        note(name, generated=True, fixture=fixture, verified=False, **sample)
        if name in ['DIBV5-BI_RGB-only', 'mislabeled-JPEG']:
            assert value['selected']['method'] == 'decoded-reencoded'
            assert not value['rawPng']['ok']
            if name == 'DIBV5-BI_RGB-only':
                assert value['image']['value']['width'] == 2
            else:
                assert value['image']['value']['width'] == 1024
        else:
            assert value['selected'] is None
        if name == 'DIBV5-BI_BITFIELDS-only':
            assert 'buffer' in value['image']['error']
            REPORT['tests'][-1]['knownLimitation'] = 'Generated DIBV5 BI_BITFIELDS with masks inside V5 header decodes in Pillow but fails in clipboard-rs/image BMP decoder; not fallback compatibility success.'
        if name == 'marker':
            assert value['text']['value']['adjustmentsMarker']
        REPORT['tests'][-1]['verified'] = True
        save()
    set_formats([])
    REPORT['finished'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    REPORT['generatedComplete'] = True
    REPORT['passed'] = REPORT.get('browserComplete', False) and browser_cases_complete(REPORT)
    save()


if __name__ == '__main__':
    try:
        if '--generated-only' in sys.argv:
            previous = json.loads((OUT / 'results.json').read_text(encoding='utf-8'))
            assert previous['executableSha256'] == REPORT['executableSha256']
            assert previous.get('browserComplete') and browser_cases_complete(previous)
            REPORT = previous
            REPORT.pop('fatalError', None)
            REPORT['tests'] = [t for t in REPORT['tests'] if not t.get('generated')]
            generated_cases()
        else:
            main()
    except Exception:
        REPORT['fatalError'] = traceback.format_exc()
        REPORT['passed'] = False
        save()
        raise
