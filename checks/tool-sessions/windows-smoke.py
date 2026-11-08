"""Task 5 Windows controller. Authoring/static checks do NOT certify Windows.

Parent stages this file, unchanged baseline windows-cdp.py / observe.js and
keyboardUtils.ts in E:/projects/tbt/rapidraw-tool-sessions. The executable is
E:/projects/tbt/rapidraw-baseline/app/src-tauri/target/release/RapidRAW-sessions.exe.
Requires the existing interactive Windows venv (websocket-client, pywin32, Pillow).
No credentials, model generation, export, network AI or production edits.

evidence/fixture.json contract (exact absolute Windows paths in parent's file;
ROOT-relative paths also accepted; exactly these two NASA copies):
{"files":[
 {"path":"fixture/photo-000.NEF","sourceRel":"set-a/photo-000.NEF",
  "sha256":"5922721d13f11795557d97fdeb0a60b900086c402bc82a848ff280d15b99ffd4","bytes":10656312},
 {"path":"fixture/photo-002.NEF","sourceRel":"set-c/photo-002.NEF",
  "sha256":"b21e9752aaf8e678fe4d8138986bc9819aa89b7b969a28d43c619af3bd6d58c1","bytes":17202207}]}
The fixture directory must initially contain only these RAWs. No sidecar seeds.
Never point it at personal photos. Helpers are hashed before and after use;
their bytes and Tauri invoke/ipc/postMessage are never changed. Measured edits
use CDP Input only; React inspection uses current-root DFS ownership, not stale
alternate or return-chain props. Canvas portals use real props.overlayRoot.

Result is exclusive-create evidence/windows-smoke.json. Errors remain failed;
groups may continue, but exit 0 requires ALL planned cases, supplemental browser
coverage AND cleanup, including three owned-Windows-client PNG captures. The
parent subsequently reads these images and writes a separate hash-bound agent
visual review as the publication gate; no handshake or review wait occurs here.
Failed attempts stay in parent's attempts directory, never enter the repository.
Private profile-backup is LOCAL RECOVERY ONLY: never archive/download/publish it.
Original settings.json and window_state.json bytes/existence are durably backed
up behind a verified current-user ACL before mutation; restoration requires
verified shutdown of the entire owned process tree. Failed launch without an
owned root handle withholds restoration, even if no window is visible.

Supplemental ROOT/browser-coverage.json may be staged by parent before running.
It must bind scriptSha256 and exeSha256 and reference a hashed ROOT-relative
artifact containing the actual browser case records. See validate_browser().
Busy cases are explicitly notnativegeneration and are never counted as native.
No editor/store flag is programmatically set by this Windows controller.
Missing browser evidence is a coverage failure (exit 1), not native generation.
"""

import copy
import gzip
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import traceback


ROOT = Path(r"E:\projects\tbt\rapidraw-tool-sessions")
BASE = Path(r"E:\projects\tbt\rapidraw-baseline")
EXE = BASE / "app/src-tauri/target/release/RapidRAW-sessions.exe"
OUT = ROOT / "evidence"
OUTPUT = OUT / "windows-smoke.json"
TITLE = "RapidRAW TBT"
FROZEN = {
    "windows-cdp.py": "afbb755826f3691ce84296d52446507d25ad1877fde0cb00d8f8dd6f866ffc64",
    "observe.js": "487c7acf01b9cbbc4d00091d584e16755dfdeb08e644759edc0a1d2f2b3dc87b",
}
NASA = {
    "A": ("fixture/photo-000.NEF", "set-a/photo-000.NEF", "5922721d13f11795557d97fdeb0a60b900086c402bc82a848ff280d15b99ffd4", 10656312),
    "B": ("fixture/photo-002.NEF", "set-c/photo-002.NEF", "b21e9752aaf8e678fe4d8138986bc9819aa89b7b969a28d43c619af3bd6d58c1", 17202207),
}
TOOLS = ("crop", "masks", "ai")
GEOMETRY = ("crop", "rotation", "orientationSteps", "flipHorizontal", "flipVertical", "aspectRatio")
GROUPS = tuple(prefix + tool for prefix in ("session-", "switch-", "keyboard-", "geometry-") for tool in TOOLS)
RIGHT = '[data-panel="adjustments"][data-panel-region="rightTop"]'
ACTIONS = '[data-tool-session-actions]'
ACTION = '[data-tool-session-action="{action}"]'
# Fixed plan makes omitted cases fail even when a runner accidentally returns.
SESSION_CASES = ("enter", "edit", "slider", "curve", "cancel", "undo", "apply-reenter", "apply-edit", "apply",
                 "enter-reenter", "enter-edit", "enter-keep", "tool-switch-enter", "tool-switch-edit", "tool-switch-keep")
SWITCH_CASES = ("enter-a", "edit-a", "a-to-b", "edit-b", "cancel-b", "return-a", "return-b")
KEY_CASES = ("enter", "edit", "focus-cancel", "focused-enter-cancels", "escape-enter", "escape-edit", "escape-cancels")
GEOM_CASES = ("enter", "layout", "resize-small", "resize-back", "exit")
BROWSER_REQUIRED = tuple("busy-" + tool + "-" + flag for tool in TOOLS for flag in
                         ("isGeneratingAi", "isGeneratingAiMask", "container-isLoading", "activeAiTasks")) + ("new-image-not-ready", "ai-prompt-enter")


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def relative_file(value):
    check(isinstance(value, str) and value and "\\" not in value, "Expected slash-separated relative path")
    path = Path(value)
    check(not path.is_absolute() and ":" not in value and ".." not in path.parts, "Unsafe staged path")
    result = ROOT / path
    check(result.resolve().is_relative_to(ROOT.resolve()), "Staged path escaped ROOT")
    check(not any(p.is_symlink() for p in (result, *result.parents) if p.is_relative_to(ROOT)), "Symlink in staged path")
    return result


def load_fixtures(report):
    candidates = [p for p in (ROOT / "fixture.json", OUT / "fixture.json") if p.is_file()]
    check(len(candidates) == 1, "Stage exactly one fixture.json at ROOT or evidence")
    path = candidates[0]
    check(not path.is_symlink(), "Fixture manifest is a symlink")
    manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    rows = manifest.get("files")
    check(isinstance(rows, list) and len(rows) == 2, "fixture.files must contain A and B only")
    check(all(isinstance(r, dict) for r in rows), "Invalid fixture records")
    check({r.get("sourceRel") for r in rows} == {v[1] for v in NASA.values()}, "Duplicate/missing NASA sources")
    photos = {}
    for row in rows:
        ident = next(k for k, v in NASA.items() if v[1] == row["sourceRel"])
        expected = NASA[ident]
        check(row.get("id", ident) == ident and tuple(row.get(k) for k in ("sourceRel", "sha256", "bytes")) == expected[1:],
              "Fixture differs from authorized NASA manifest: " + ident)
        photo = Path(row["path"])
        if not photo.is_absolute():
            photo = ROOT / photo
        check(photo.resolve() == (ROOT / expected[0]).resolve(), "Fixture path is not exact isolated NASA copy")
        check(not any(p.is_symlink() for p in (photo, *photo.parents) if p.is_relative_to(ROOT)), "Linked fixture path")
        check(photo.is_file() and photo.stat().st_size == row["bytes"] and sha(photo) == row["sha256"], "RAW identity mismatch")
        photos[ident] = ROOT / expected[0]
    for key, expected in (("sourceRel", NASA["A"][1]), ("sha256", NASA["A"][2]), ("bytes", NASA["A"][3])):
        check(key not in manifest or manifest[key] == expected, "Top-level A alias mismatch: " + key)
    for key, ident in (("path", "A"), ("secondPath", "B")):
        if key in manifest:
            alias = Path(manifest[key])
            check((alias if alias.is_absolute() else ROOT / alias).resolve() == photos[ident].resolve(), "Fixture path alias mismatch")
    check(set((ROOT / "fixture").iterdir()) == set(photos.values()), "Fresh fixture directory must contain only A/B RAW")
    report.update(fixture=manifest, fixtureManifestPath=str(path), fixtureManifestSha256=sha(path), rawBefore={k: sha(v) for k, v in photos.items()})
    return photos


def backup_profiles(original, report):
    import ntsecuritycon
    import win32api
    import win32security
    path = ROOT / "profile-backup"
    path.mkdir(mode=0o700, exist_ok=False)
    report["profileBackup"] = {"private": False, "verified": False,
                               "publication": "LOCAL RECOVERY ONLY; exclude entire profile-backup directory"}
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()
    acl = win32security.ACL()
    acl.AddAccessAllowedAceEx(win32security.ACL_REVISION, 3, ntsecuritycon.FILE_ALL_ACCESS, sid)
    info = win32security.DACL_SECURITY_INFORMATION
    win32security.SetNamedSecurityInfo(str(path), win32security.SE_FILE_OBJECT,
                                      info | win32security.PROTECTED_DACL_SECURITY_INFORMATION, None, None, acl, None)
    descriptor = win32security.GetNamedSecurityInfo(str(path), win32security.SE_FILE_OBJECT, info)
    actual = descriptor.GetSecurityDescriptorDacl()
    check(descriptor.GetSecurityDescriptorControl()[0] & 0x1000 and actual is not None and
          actual.GetAceCount() == 1 and actual.GetAce(0)[2] == sid and
          actual.GetAce(0)[1] == ntsecuritycon.FILE_ALL_ACCESS, "Private backup ACL verification failed")
    report["profileBackup"]["private"] = True
    manifest = []
    for source, data in original.items():
        manifest.append({"file": source.name, "existed": data is not None,
                         "sha256": hashlib.sha256(data).hexdigest() if data is not None else None})
        if data is not None:
            with (path / source.name).open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            check((path / source.name).read_bytes() == data, "Private backup readback failed")
    encoded = (json.dumps({"schema": "rapidraw-private-profile-backup-v1", "files": manifest}, indent=2) + "\n").encode()
    with (path / "manifest.json").open("xb") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    check((path / "manifest.json").read_bytes() == encoded, "Private manifest readback failed")
    report["profileBackup"].update(verified=True, files=manifest, manifestSha256=sha(path / "manifest.json"))


def process_table():
    """PID ancestry only; never capture other applications' command lines."""
    import ctypes
    from ctypes import wintypes as w

    class Entry(ctypes.Structure):
        _fields_ = [("size", w.DWORD), ("usage", w.DWORD), ("pid", w.DWORD), ("heap", ctypes.c_size_t),
                    ("module", w.DWORD), ("threads", w.DWORD), ("parent", w.DWORD), ("priority", w.LONG),
                    ("flags", w.DWORD), ("exe", w.WCHAR * 260)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes, kernel.CreateToolhelp32Snapshot.restype = [w.DWORD, w.DWORD], w.HANDLE
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32FirstW.restype = kernel.Process32NextW.restype = w.BOOL
    kernel.CloseHandle.argtypes = [w.HANDLE]
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    check(handle != ctypes.c_void_p(-1).value, "Cannot snapshot ownership")
    result = {}
    try:
        entry = Entry()
        entry.size = ctypes.sizeof(entry)
        more = kernel.Process32FirstW(handle, ctypes.byref(entry))
        check(bool(more), "Cannot read ownership snapshot")
        while more:
            result[entry.pid] = {"pid": entry.pid, "parent": entry.parent, "exe": entry.exe}
            more = kernel.Process32NextW(handle, ctypes.byref(entry))
        check(ctypes.get_last_error() == 18, "Ownership enumeration interrupted before ERROR_NO_MORE_FILES")
    finally:
        kernel.CloseHandle(handle)
    return result


def process_token(pid, terminate_token=None):
    import ctypes
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes, kernel.OpenProcess.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
    kernel.GetProcessTimes.argtypes = [w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4
    kernel.GetProcessTimes.restype = w.BOOL
    kernel.GetExitCodeProcess.argtypes, kernel.GetExitCodeProcess.restype = [w.HANDLE, ctypes.POINTER(w.DWORD)], w.BOOL
    kernel.TerminateProcess.argtypes, kernel.TerminateProcess.restype = [w.HANDLE, w.UINT], w.BOOL
    kernel.CloseHandle.argtypes = [w.HANDLE]
    handle = kernel.OpenProcess(0x1000 | (1 if terminate_token is not None else 0), False, pid)
    if not handle:
        check(ctypes.get_last_error() == 87, "Cannot query owned PID " + str(pid))
        return None
    try:
        exit_code = w.DWORD()
        check(kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)), "Cannot query owned exit code")
        if exit_code.value != 259:
            return None
        created, exited, cpu, user = (w.FILETIME() for _ in range(4))
        check(kernel.GetProcessTimes(handle, *map(ctypes.byref, (created, exited, cpu, user))), "Cannot query creation time")
        token = (created.dwHighDateTime << 32) | created.dwLowDateTime
        if terminate_token is not None and token == terminate_token:
            check(kernel.TerminateProcess(handle, 1), "Cannot stop owned descendant")
        return token
    finally:
        kernel.CloseHandle(handle)


def scan_owned_tree(process, root_token, known, report):
    """Extend from ALL captured identities, including after the root exits.

    known is keyed by (PID, creation time); a reused PID never erases its old
    identity. New children require a live, identity-matching parent on both
    sides of their capture and a second ancestry snapshot. An orphan linked
    to a captured but dead/reused parent cannot be safely attributed or killed:
    retain that uncertainty permanently and withhold profile restoration.
    """
    issues = report.setdefault("ownershipUncertainties", [])
    table = process_table()

    def uncertain(row, reason):
        issue = {"pid": row["pid"], "parent": row["parent"], "reason": reason}
        if issue not in issues:
            issues.append(issue)

    while True:
        identities = {(process.pid, root_token), *known.keys()}
        parents = {}
        for pid, token in identities:
            parents.setdefault(pid, set()).add(token)
        changed = False
        for pid, row in table.items():
            if row["parent"] not in parents:
                continue
            token = process_token(pid)
            if token is None:
                if not any(key[0] == pid for key in identities):
                    uncertain(row, "Descendant exited before identity capture; possible surviving descendants")
                continue
            if (pid, token) in identities:
                continue
            possible = {t for t in parents[row["parent"]] if t <= token}
            if not possible:
                # Older than every captured parent incarnation: unrelated.
                continue
            parent_token = process_token(row["parent"])
            if parent_token not in possible:
                uncertain(row, "New descendant linked to exited/reused parent; ownership unprovable")
                continue
            confirmed = process_table().get(pid)
            if (confirmed is None or confirmed["parent"] != row["parent"] or
                    process_token(pid) != token or process_token(row["parent"]) != parent_token):
                uncertain(row, "Parent/child identity or ancestry changed during capture")
                continue
            known[(pid, token)] = {**confirmed, "creationToken": token, "parentCreationToken": parent_token}
            changed = True
        if not changed:
            break
    return [p for p in known.values() if process_token(p["pid"]) == p["creationToken"]]


def stop_tree(process, hwnd, root_token, known, report):
    report["ownedTreeShutdownVerified"] = False
    scan_owned_tree(process, root_token, known, report)
    report["ownedDescendantsBeforeClose"] = list(known.values())
    if process.poll() is None:
        if hwnd is not None and win32gui.IsWindow(hwnd) and win32process.GetWindowThreadProcessId(hwnd)[1] == process.pid:
            win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
        deadline = time.monotonic() + 20
        while process.poll() is None and time.monotonic() < deadline:
            scan_owned_tree(process, root_token, known, report)
            time.sleep(0.1)
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=20)
    # Root exit does not end discovery. WebView children may still create
    # children while they shut down, or while a captured child is terminated.
    deadline = time.monotonic() + 5
    while True:
        alive = scan_owned_tree(process, root_token, known, report)
        if not alive or time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    for row in alive:
        process_token(row["pid"], terminate_token=row["creationToken"])
    deadline = time.monotonic() + 5
    while True:
        remaining = scan_owned_tree(process, root_token, known, report)
        if not remaining or time.monotonic() >= deadline:
            break
        for row in remaining:
            process_token(row["pid"], terminate_token=row["creationToken"])
        time.sleep(0.1)
    report["ownedDescendantsAllCaptured"] = list(known.values())
    report["ownedDescendantsRemaining"] = remaining
    check(not remaining and process.poll() is not None, "Owned process tree still alive")
    check(not report.get("ownershipUncertainties"), "Entire owned tree shutdown unprovable; profile restoration forbidden")
    report["ownedTreeShutdownVerified"] = True


OBSERVER_JS = r"""(() => {
  if(window.sessionsSmoke)throw Error('Use fresh process');
  const s=window.sessionsSmoke={events:[],calls:[],errors:[],caseName:'setup',armed:false,
    allowedPaths:[],transitions:[],notReadySamples:[],knownPaths:[]};
  const internal=window.__TAURI_INTERNALS__,originalFetch=window.fetch;
  if(!internal?.invoke)throw Error('Real Tauri internals required');
  const before={invoke:internal.invoke,ipc:internal.ipc,postMessage:internal.postMessage};
  s.tree=()=>{
    const host=[...document.querySelectorAll('#root *')].find(n=>Object.keys(n).some(k=>k.startsWith('__reactFiber$')));
    if(!host)throw Error('No React host');
    let f=host[Object.keys(host).find(k=>k.startsWith('__reactFiber$'))];
    while(f.return)f=f.return;
    const root=f.stateNode?.current;if(!root)throw Error('No current mounted root');
    const hosts=new Map(),components=[];
    const visit=(fiber,ancestors)=>{
      const chain=[fiber,...ancestors];
      if(typeof fiber.type==='string'&&fiber.stateNode instanceof Element)hosts.set(fiber.stateNode,chain);
      else if(fiber.memoizedProps)components.push({fiber,chain,p:fiber.memoizedProps});
      for(let c=fiber.child;c;c=c.sibling)visit(c,chain);
    };visit(root,[]);return {hosts,components};
  };
  s.props=(node,predicate)=>{
    const chain=s.tree().hosts.get(node);if(!chain)throw Error('Detached/stale React host');
    return chain.find(f=>typeof f.type!=='string'&&predicate(f.memoizedProps))?.memoizedProps??null;
  };
  s.hosts=f=>{const nodes=[];const visit=n=>{
    if(typeof n.type==='string'&&n.stateNode instanceof Element){nodes.push(n.stateNode);return;}
    for(let c=n.child;c;c=c.sibling)visit(c);
  };visit(f);return nodes;};
  s.components=(predicate,scope=document)=>s.tree().components.filter(c=>predicate(c.p)).map(c=>({
    ...c,nodes:s.hosts(c.fiber).filter(n=>n.isConnected&&scope.contains(n))
  })).filter(c=>c.nodes.length);
  s.component=(predicate,scope=document)=>{
    const all=s.components(predicate,scope);if(all.length!==1)throw Error('Expected one owned component, got '+all.length);
    return {...all[0],node:all[0].nodes[0]};
  };
  s.visible=n=>{
    if(!n?.isConnected)return false;
    const r=n.getBoundingClientRect();let l=Math.max(0,r.left),t=Math.max(0,r.top),rr=Math.min(innerWidth,r.right),b=Math.min(innerHeight,r.bottom);
    for(let p=n;p;p=p.parentElement){const c=getComputedStyle(p),q=p.getBoundingClientRect();
      if(c.display==='none'||c.visibility==='hidden'||Number(c.opacity)===0)return false;
      if(/auto|scroll|hidden|clip/.test(c.overflowX)){l=Math.max(l,q.left);rr=Math.min(rr,q.right);}
      if(/auto|scroll|hidden|clip/.test(c.overflowY)){t=Math.max(t,q.top);b=Math.min(b,q.bottom);}}
    return rr>l&&b>t;
  };
  s.one=(selector,scope=document,visible=true)=>{
    const all=[...scope.querySelectorAll(selector)].filter(n=>n.isConnected&&(!visible||s.visible(n)));
    if(all.length!==1)throw Error('Expected one '+selector+', got '+all.length);return all[0];
  };
  s.mark=(n,role)=>{if(!n)throw Error('Missing '+role);n.setAttribute('data-sessions-smoke-role',role);return n;};
  s.canvas=()=>{
    const c=s.component(p=>p?.selectedImage&&typeof p.isCropping==='boolean'&&typeof p.isMasking==='boolean'&&
      typeof p.isAiEditing==='boolean'&&typeof p.handleCropComplete==='function'&&p.imageRenderSize);
    const root=c.p.overlayRoot;
    return {...c,overlayRoot:root instanceof Element&&root.isConnected?root:null};
  };
  s.canvasNodes=(selector,visible=true,canvas=s.canvas())=>{
    const tree=s.tree(),roots=[...new Set([...canvas.nodes,canvas.overlayRoot].filter(Boolean))];
    return [...new Set(roots.flatMap(root=>[...root.querySelectorAll(selector)]))].filter(node=>{
      let owned=false;
      for(let n=node;n instanceof Element;n=n.parentElement){
        const chain=tree.hosts.get(n);if(chain){owned=chain.includes(canvas.fiber);break;}
        if(roots.includes(n))break;
      }
      return owned&&node.isConnected&&(!visible||s.visible(node));
    });
  };
  s.canvasOne=selector=>{const all=s.canvasNodes(selector);
    if(all.length!==1)throw Error('Expected one current canvas-owned portal '+selector+', got '+all.length);return all[0];};
  s.graph=()=>{
    const root=s.one('[data-panel=curves][data-panel-region=leftTop]');
    const graph=s.one('svg[viewBox="0 0 255 255"]',root,false);
    const p=s.props(graph,p=>p?.adjustments?.curves&&typeof p.setAdjustments==='function');
    if(!p||p.isForMask)throw Error('Missing actual global curve props');return graph;
  };
  s.basic=()=>{
    const scope=s.one('[data-panel=adjustments][data-panel-region=rightTop]');
    return s.component(p=>p?.sectionName==='basic'&&p.adjustments&&typeof p.setAdjustments==='function',scope).p.adjustments;
  };
  s.thumb=path=>{
    const all=[...document.querySelectorAll('[data-tooltip^="photo-"]')].filter(n=>{
      const p=s.props(n,p=>!!p?.imageFile?.path);return p?.imageFile.path===path;
    });if(all.length!==1)throw Error('Missing/ambiguous current thumbnail '+path);return all[0];
  };
  const headingState=panel=>{
    const title={masks:'Masking',ai:'Inpainting'}[panel];if(!title)throw Error('Unsupported tool heading');
    const tree=s.tree(),roots=[...document.querySelectorAll('[data-panel="'+panel+'"]')];
    const describe=n=>{const c=getComputedStyle(n);return {
      tag:n.tagName,panel:n.getAttribute('data-panel'),region:n.getAttribute('data-panel-region'),
      rect:n.getBoundingClientRect().toJSON(),currentOwned:tree.hosts.has(n),
      styles:{display:c.display,visibility:c.visibility,opacity:c.opacity,overflowX:c.overflowX,overflowY:c.overflowY,
        position:c.position,contentVisibility:c.contentVisibility??null},
      scrollTop:n.scrollTop,scrollLeft:n.scrollLeft,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,
      clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,
      clipsX:/auto|scroll|hidden|clip/.test(c.overflowX),clipsY:/auto|scroll|hidden|clip/.test(c.overflowY)};};
    const ancestry=n=>{const all=[];for(let p=n;p;p=p.parentElement)all.push(describe(p));return all;};
    const renderable=(n,ancestors)=>n.isConnected&&n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0&&
      ancestors.every(a=>a.styles.display!=='none'&&!['hidden','collapse'].includes(a.styles.visibility)&&
        Number.isFinite(Number(a.styles.opacity))&&Number(a.styles.opacity)>0&&a.styles.contentVisibility!=='hidden');
    const evidence={panel,title,roots:roots.map(describe),root:null,headings:[],heading:null,
      readyForScroll:false,visible:false,fatal:null,reasons:[]};
    if(roots.length!==1){if(roots.length>1)evidence.fatal='Ambiguous actual panel root';
      evidence.reasons.push('Expected one actual panel root');return {evidence,node:null};}
    const root=roots[0],rootChain=tree.hosts.get(root),rootProps=rootChain?.[0]?.memoizedProps;
    const rootOwned=!!rootChain&&rootProps?.['data-panel']===panel&&rootProps?.['data-panel-region']==='leftBottom'&&
      rootChain.some(f=>f.memoizedProps?.region==='leftBottom'&&f.memoizedProps?.side==='left'&&typeof f.memoizedProps?.renderPanel==='function');
    const rootAncestors=ancestry(root);evidence.root={...describe(root),ownerMatches:rootOwned,ancestors:rootAncestors};
    const headings=[...root.querySelectorAll('h2')];
    evidence.headings=headings.map(n=>({...describe(n),text:n.textContent.trim().slice(0,100)}));
    const matching=headings.filter(n=>n.textContent.trim()===title);
    if(matching.length!==1){if(matching.length>1)evidence.fatal='Ambiguous actual panel heading';
      evidence.reasons.push('Expected one exact tool heading');return {evidence,node:null};}
    const node=matching[0],chain=tree.hosts.get(node),rootIndex=chain?.indexOf(rootChain?.[0])??-1;
    const inside=rootIndex>=0?chain.slice(0,rootIndex):[];
    const pane=inside.find(f=>f.key===panel);
    const exiting=inside.some(f=>f.memoizedProps?.isPresent===false);
    const ownerMatches=rootOwned&&!!chain&&rootIndex>=0&&!!pane&&!exiting;
    const ancestors=ancestry(node);
    evidence.heading={...describe(node),text:node.textContent.trim(),ancestors,ownerMatches,
      paneKey:pane?.key??null,exiting,rootInCurrentAncestry:rootIndex>=0};
    evidence.readyForScroll=ownerMatches&&renderable(root,rootAncestors)&&renderable(node,ancestors);
    evidence.visible=evidence.readyForScroll&&s.visible(node);
    if(!ownerMatches)evidence.reasons.push('Heading/root/current pane ownership mismatch or exiting pane');
    if(!evidence.readyForScroll)evidence.reasons.push('Expected current heading with renderable layout and nontransparent styles');
    return {evidence,node};
  };
  s.headingEvidence=panel=>headingState(panel).evidence;
  s.panelHeading=panel=>{const state=headingState(panel);
    if(!state.evidence.readyForScroll)throw Error('Actual current heading is not renderable');return state.node;};
  s.panelMounted=panel=>headingState(panel).evidence.visible;
  const containerPredicate=id=>p=>p?.container?.id===id&&typeof p.onToggle==='function'&&
    typeof p.updateContainer==='function';
  const subMaskPredicate=id=>p=>p?.subMask?.id===id&&typeof p.onSelect==='function';
  s.containerMounted=(panel,id)=>{
    const all=s.components(containerPredicate(id),s.one('[data-panel="'+panel+'"]'));
    if(all.length>1)throw Error('Ambiguous current ContainerRow '+id);return all.length===1;
  };
  s.subMaskMounted=(panel,id)=>{
    const all=s.components(subMaskPredicate(id),s.one('[data-panel="'+panel+'"]'));
    if(all.length>1)throw Error('Ambiguous current SubMaskRow '+id);return all.length===1;
  };
  s.brushInfo=panel=>{
    // Data existence is independent of AnimatePresence's mounted list. Never
    // infer that a ContainerRow is mounted merely because its data exists.
    const key=panel==='masks'?'masks':'aiPatches';
    const containers=s.canvas().p.adjustments[key]??[];
    const parent=containers.filter(c=>(c.subMasks??[]).some(m=>m.type==='brush')).at(-1);
    if(parent){
      const sub=parent.subMasks.filter(m=>m.type==='brush').at(-1);
      return {existing:true,containerId:parent.id,id:sub.id};
    }
    return {existing:false};
  };
  s.brushContainer=panel=>{
    const info=s.brushInfo(panel);
    if(!info.existing)throw Error('No existing Brush container');
    return s.component(containerPredicate(info.containerId),s.one('[data-panel="'+panel+'"]'));
  };
  const brushTilePredicate=p=>p?.maskType?.type==='brush'&&p.maskType.disabled===false&&typeof p.onClick==='function';
  s.brushTileMounted=panel=>{
    const all=s.components(brushTilePredicate,s.one('[data-panel="'+panel+'"]'));
    if(all.length>1)throw Error('Ambiguous actual Brush creation component');return all.length===1;
  };
  s.brushTarget=panel=>{
    const root=s.one('[data-panel="'+panel+'"]'),info=s.brushInfo(panel);
    if(info.existing){
      const c=s.component(subMaskPredicate(info.id),root);
      return c.nodes[0];
    }
    const tiles=[...root.querySelectorAll('[role=button]')].filter(n=>n.innerText.trim()==='Brush');
    if(tiles.length!==1)throw Error('Expected exact Brush creation tile, got '+tiles.length);
    const owner=s.props(tiles[0],p=>p?.maskType?.type==='brush'&&typeof p.onClick==='function');
    if(!owner)throw Error('Brush tile is not owned by real DraggableGridItem');
    return tiles[0];
  };
  s.drawingMounted=()=>{const all=s.canvasNodes('.konvajs-content').filter(n=>[...n.querySelectorAll('canvas')].some(s.visible));
    if(all.length>1)throw Error('Ambiguous actual drawing stage');return all.length===1;};
  s.drawing=()=>{const all=s.canvasNodes('.konvajs-content').filter(n=>[...n.querySelectorAll('canvas')].some(s.visible));
    if(all.length!==1)throw Error('Missing/ambiguous drawing stage');return all[0];};
  s.actions=()=>{
    const roots=[...document.querySelectorAll('[data-tool-session-actions]')];
    if(roots.length>1)throw Error('Ambiguous tool-session action bar');
    const tree=s.tree();
    return roots.map(n=>{if(!tree.hosts.has(n))throw Error('Action bar is not current React host');
      return {rect:n.getBoundingClientRect().toJSON(),visible:s.visible(n),
      buttons:['apply','cancel'].map(action=>{const b=s.one('[data-tool-session-action="'+action+'"]',n,false);
        if(b.tagName!=='BUTTON')throw Error('Action must be real button');
        const owner=s.props(b,p=>p?.['data-tool-session-action']===action&&typeof p.onClick==='function'&&typeof p.disabled==='boolean');
        if(!owner||owner.disabled!==b.disabled)throw Error('Button DOM/current owning props disagree');
        return {action,disabled:b.disabled,visible:s.visible(b),rect:b.getBoundingClientRect().toJSON(),focused:document.activeElement===b};})};});
  };
  s.describe=n=>({tag:n?.tagName,action:n?.closest('[data-tool-session-action]')?.getAttribute('data-tool-session-action')??null,
    panel:n?.closest('[data-panel]')?.dataset.panel??null,role:n?.closest('[data-sessions-smoke-role]')?.getAttribute('data-sessions-smoke-role')??null});
  for(const type of ['pointerdown','pointermove','pointerup','pointercancel','mousedown','mousemove','mouseup','click','contextmenu',
    'keydown','keyup','input','beforeinput','focusin','focusout'])window.addEventListener(type,e=>{
      if(type.endsWith('move')&&!e.buttons)return;
      const n=e.target instanceof Element?e.target:null;
      s.events.push({type,trusted:e.isTrusted,caseName:s.caseName,...s.describe(n),code:e.code??null,key:e.key??null,
        x:e.clientX??null,y:e.clientY??null,buttons:e.buttons??null,ctrl:e.ctrlKey??false,shift:e.shiftKey??false,
        alt:e.altKey??false,at:performance.now()});
    },true);
  const hook={verified:false,promiseIdentity:false,responseIdentity:false,errors:[]};
  // Only command names and transport outcomes. Never request bodies, auth
  // headers, settings, metadata, response payloads or exception messages.
  function observedFetch(...args){
    let row=null;
    try{const input=args[0],url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href);
      if(url.hostname==='ipc.localhost'){const command=decodeURIComponent(url.pathname.slice(1));
        row={command,caseName:s.caseName,at:performance.now(),status:'pending'};s.calls.push(row);}
    }catch{hook.errors.push('fetch observation parse failure');}
    let promise;
    try{promise=Reflect.apply(originalFetch,this,args);}catch(error){if(row)row.status='throw';throw error;}
    if(row)promise.then(response=>{row.httpStatus=response.status;row.nativeOk=response.headers.get('Tauri-Response')==='ok';
      row.status=row.nativeOk?'fulfilled':'native-error';},()=>{row.status='rejected';});
    if(s.identityProbe){s.identityProbe.originalPromise=promise;
      promise.then(response=>{s.identityProbe.originalResponse=response;},()=>{});}
    return promise;
  }
  window.fetch=observedFetch;
  s.hookStatus=()=>({...hook,installed:window.fetch===observedFetch,
    internalsUnchanged:window.__TAURI_INTERNALS__===internal&&Object.entries(before).every(([k,v])=>internal[k]===v)});
  s.assertHook=()=>{const h=s.hookStatus();if(!h.installed||!h.internalsUnchanged||!h.verified||h.errors.length||
    !h.promiseIdentity||!h.responseIdentity)throw Error('Host observer integrity failure');};
  s.probe=async()=>{
    s.identityProbe={};const returned=window.fetch('data:text/plain,tool-sessions-identity');
    hook.promiseIdentity=returned===s.identityProbe.originalPromise;
    const response=await returned;hook.responseIdentity=response===s.identityProbe.originalResponse;delete s.identityProbe;
    const start=s.calls.length,value=await internal.invoke('is_tethering_supported');
    await new Promise(r=>setTimeout(r,50));
    if(typeof value!=='boolean'||!s.calls.slice(start).some(c=>c.command==='is_tethering_supported'&&c.status==='fulfilled'))
      throw Error('Native IPC did not traverse immutable host observer');
    hook.verified=true;s.assertHook();return s.hookStatus();
  };
  s.snapshot=()=>{
    s.assertHook();const canvas=s.canvas(),p=canvas.p;
    if(!s.visible(canvas.node))throw Error('Actual ImageCanvas is not visible');
    const basic=s.basic(),graph=s.graph(),curve=s.props(graph,q=>q?.adjustments?.curves&&typeof q.setAdjustments==='function'&&!q.isForMask);
    if(!curve)throw Error('Current owning global curve component missing');
    const geometry=Object.fromEntries(['crop','rotation','orientationSteps','flipHorizontal','flipVertical','aspectRatio'].map(k=>[k,p.adjustments[k]??null]));
    return {path:p.selectedImage.path,ready:p.selectedImage.isReady,rendered:p.hasRenderedFirstFrame,
      mode:{crop:p.isCropping,masks:p.isMasking,ai:p.isAiEditing},geometry,draftCrop:p.crop,
      masks:p.adjustments.masks??[],aiPatches:p.adjustments.aiPatches??[],
      exposure:basic.exposure,curves:curve.adjustments.curves,curveMode:curve.adjustments.curveMode??null,
      adjustmentSources:{exposure:'current rightTop basic AdjustmentSection',curves:'current leftTop global Curves component',tools:'current ImageCanvas'},
      selection:{mask:p.activeMaskId??null,maskContainer:p.activeMaskContainerId??null,
        ai:p.activeAiSubMaskId??null,aiContainer:p.activeAiPatchContainerId??null},
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},actions:s.actions(),
      canvas:{rect:canvas.node.getBoundingClientRect().toJSON(),renderSize:p.imageRenderSize,
        overlayRoot:canvas.overlayRoot?{source:'current ImageCanvas.props.overlayRoot',rect:canvas.overlayRoot.getBoundingClientRect().toJSON()}:null,
        selections:s.canvasNodes('.ReactCrop__crop-selection',true,canvas).map(n=>n.getBoundingClientRect().toJSON()),
        cropImages:s.canvasNodes('img[alt="Crop preview"]',false,canvas).map(n=>({
          rect:n.getBoundingClientRect().toJSON(),naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight,visible:s.visible(n)})),
        cropFrames:s.canvasNodes('.ReactCrop',true,canvas).map(n=>({rect:n.getBoundingClientRect().toJSON(),
          sizer:n.firstElementChild?.getBoundingClientRect().toJSON()}))},
      focus:s.describe(document.activeElement),observerErrors:[...s.errors]};
  };
  s.layout=()=>{
    const c=s.canvas(),p=c.p,actions=s.actions();
    const bars=actions.filter(a=>a.visible);
    if(bars.length!==1)throw Error('Need one visible action bar');
    if(!c.overlayRoot)throw Error('Missing actual overlayRoot');
    const viewportNode=c.overlayRoot.parentElement;
    if(!viewportNode?.contains(c.node)||!s.tree().hosts.has(viewportNode))throw Error('Portal/current ImageCanvas viewport ownership mismatch');
    const viewport=viewportNode.getBoundingClientRect(),overlay=c.overlayRoot.getBoundingClientRect(),bar=bars[0].rect;
    const frames=s.canvasNodes('.ReactCrop',true,c).map(n=>({rect:n.getBoundingClientRect().toJSON(),
      sizer:n.firstElementChild?.getBoundingClientRect().toJSON()}));
    const selections=s.canvasNodes('.ReactCrop__crop-selection',true,c).map(n=>n.getBoundingClientRect().toJSON());
    // The preview image is a hidden DOM projector when native WGPU composes
    // the pixels. Its dimensions and actual overlay crop-sizer must agree.
    const images=s.canvasNodes('img[alt="Crop preview"]',false,c).filter(n=>n.naturalWidth>0).map(n=>({rect:n.getBoundingClientRect().toJSON(),
      style:getComputedStyle(n).transform,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight}));
    return {method:'owned current React/DOM geometry; no native image-pixel comparison',viewport:viewport.toJSON(),
      viewportSource:'current ImageCanvas.props.overlayRoot.parentElement (Editor imageContainer)',
      content:c.node.getBoundingClientRect().toJSON(),overlay:overlay.toJSON(),bar,buttons:bars[0].buttons,frames,selections,images,
      draft:p.crop,renderSize:p.imageRenderSize,mode:p.isCropping?'crop':p.isMasking?'masks':p.isAiEditing?'ai':'ordinary'};
  };
  const tick=()=>{if(s.armed)try{
    const c=s.canvas(),p=c.p,path=p.selectedImage.path;
    if(!s.allowedPaths.includes(path))s.errors.push('Unexpected selected image');
    if(s.transitions.at(-1)?.path!==path)s.transitions.push({path,ready:p.selectedImage.isReady,at:performance.now(),caseName:s.caseName});
    if(!p.selectedImage.isReady&&(p.isCropping||p.isMasking||p.isAiEditing))s.notReadySamples.push({path,actions:s.actions(),at:performance.now(),caseName:s.caseName});
  }catch{s.errors.push('Current canvas sampling failed');}requestAnimationFrame(tick);};requestAnimationFrame(tick);
})()"""


def req(kind, role=None, code=None):
    return {"type": kind, **({"role": role} if role else {}), **({"code": code} if code else {})}


def active(state, tool):
    wanted = {k: k == tool for k in TOOLS}
    if state["mode"] != wanted:
        return False
    bars = state["actions"]
    if tool in TOOLS:
        return len(bars) == 1 and bars[0]["visible"] and all(b["visible"] and not b["disabled"] for b in bars[0]["buttons"])
    return not bars


def value(state, tool):
    return copy.deepcopy(state[{"crop": "geometry", "masks": "masks", "ai": "aiPatches"}[tool]])


def compare_persisted_tool(expected, actual, tool):
    """Only persisted Brush point x/y may differ by <=1e-9 pixels.

    Objects retain exact key sets; arrays retain order/length. All other types
    and values are exact. Neither input nor raw case snapshots are normalized.
    Hashes identify canonical JSON encodings, NOT original IPC/report bytes.
    """
    field = {"crop": "geometry", "masks": "masks", "ai": "aiPatches"}[tool]
    tolerance = 1e-9
    differences = []

    def finite_number(number):
        try:
            return type(number) in (int, float) and math.isfinite(number)
        except OverflowError:
            return False

    def coordinate(path):
        return (tool in ("masks", "ai") and len(path) == 10 and path[0] == field and
                all(type(path[i]) is int for i in (1, 3, 6, 8)) and
                path[2] == "subMasks" and path[4:6] == ("parameters", "lines") and path[7] == "points" and path[9] in ("x", "y") and
                expected[path[1]]["subMasks"][path[3]].get("type") == "brush" and
                actual[path[1]]["subMasks"][path[3]].get("type") == "brush")

    def visit(left, right, path):
        label = "".join(("[" + str(k) + "]") if type(k) is int else (("." if i else "") + k) for i, k in enumerate(path))
        if coordinate(path):
            finite = finite_number(left) and finite_number(right)
            delta = abs(left - right) if finite else None
            accepted = finite and delta <= tolerance
            if not accepted or type(left) is not type(right) or left != right:
                differences.append({"path": label, "kind": "brush-coordinate", "expected": left, "actual": right,
                                    "delta": delta, "tolerance": tolerance, "accepted": accepted})
        elif type(left) is not type(right):
            differences.append({"path": label, "kind": "type", "expected": type(left).__name__, "actual": type(right).__name__, "accepted": False})
        elif isinstance(left, dict):
            if left.keys() != right.keys():
                differences.append({"path": label, "kind": "keys", "expected": sorted(left), "actual": sorted(right), "accepted": False})
            for key in left.keys() & right.keys():
                visit(left[key], right[key], (*path, key))
        elif isinstance(left, list):
            if len(left) != len(right):
                differences.append({"path": label, "kind": "length", "expected": len(left), "actual": len(right), "accepted": False})
            for index, (a, b) in enumerate(zip(left, right)):
                visit(a, b, (*path, index))
        elif left != right:
            differences.append({"path": label, "kind": "value", "expected": left, "actual": right, "accepted": False})

    visit(expected, actual, (field,))
    canonical_sha = lambda data: hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {"equal": all(d["accepted"] for d in differences), "scope": "switch_group persistence only",
            "coordinateTolerancePixels": tolerance, "rawValuesPreserved": True,
            "valueHashEncoding": "UTF-8 Python JSON, sorted object keys, compact separators; no value normalization",
            "expectedValueCanonicalJsonSha256": canonical_sha(expected), "actualValueCanonicalJsonSha256": canonical_sha(actual),
            "differences": sorted(differences, key=lambda d: d["path"])}


def globals_equal(a, b):
    return all(a[k] == b[k] for k in ("exposure", "curves", "curveMode"))


def others_equal(a, b, tool):
    return all(value(a, k) == value(b, k) for k in TOOLS if k != tool)


def drawn_lines(state, tool):
    return sum(len(sm.get("parameters", {}).get("lines", [])) for c in value(state, tool) for sm in c.get("subMasks", []))


def new_stroke(before, after, tool):
    previous = {sm["id"]: len(sm.get("parameters", {}).get("lines", []))
                for c in value(before, tool) for sm in c.get("subMasks", [])}
    return any(len(line.get("points", [])) >= 2
               for c in value(after, tool) for sm in c.get("subMasks", []) if sm.get("type") == "brush"
               for line in sm.get("parameters", {}).get("lines", [])[previous.get(sm["id"], 0):])


def expected_cases():
    cases = {}
    for tool in TOOLS:
        cases["session-" + tool] = list(SESSION_CASES)
        cases["switch-" + tool] = list(SWITCH_CASES)
        extra = ["escape-submask", "escape-container"] if tool != "crop" else []
        if tool == "masks":
            extra += ["rename-enter", "rename-input-enter"]
        cases["keyboard-" + tool] = list(KEY_CASES) + extra
        cases["geometry-" + tool] = list(GEOM_CASES)
    return cases


class Smoke:
    def __init__(self, driver, process, cdp, hwnd, root_token, photos, report):
        self.driver, self.process, self.cdp, self.hwnd = driver, process, cdp, hwnd
        self.root_token, self.photos, self.report = root_token, photos, report
        self.known, self.group, self.details = {}, "setup", {}
        self.target = photos["A"]

    def js(self, expression):
        return self.cdp.js(expression)

    def frame(self):
        self.js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

    def snapshot(self):
        return self.js("sessionsSmoke.snapshot()")

    def track(self):
        scan_owned_tree(self.process, self.root_token, self.known, self.report)

    def point(self, expression, role, fx=0.5, fy=0.5):
        self.js("sessionsSmoke.mark((" + expression + ")," + json.dumps(role) + ").scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})")
        self.frame()
        return self.js("""(() => {const e=(""" + expression + """),r=e.getBoundingClientRect();
          if(e.disabled||e.getAttribute('aria-disabled')==='true')throw Error('Disabled input target');
          const x=r.left+r.width*""" + str(fx) + ",y=r.top+r.height*" + str(fy) + """;
          if(!sessionsSmoke.visible(e)||!e.contains(document.elementFromPoint(x,y)))throw Error('Input target occluded');
          return {x,y};})()""")

    def mouse(self, kind, point, buttons=None, button="left"):
        self.cdp.call("Input.dispatchMouseEvent", {"type": kind, **point, "button": button,
                      "buttons": (0 if kind == "mouseReleased" else 1) if buttons is None else buttons,
                      "clickCount": 0 if kind == "mouseMoved" else 1})

    def click_expr(self, expression, role, fx=0.5, fy=0.5):
        point = self.point(expression, role, fx, fy)
        self.mouse("mouseMoved", point, 0)
        self.mouse("mousePressed", point)
        self.mouse("mouseReleased", point)
        self.frame()

    def click(self, selector, role, fx=0.5, fy=0.5):
        self.click_expr("sessionsSmoke.one(" + json.dumps(selector) + ",document,false)", role, fx, fy)

    def key(self, code, modifiers=0):
        special = {"Escape": ("Escape", 27), "Enter": ("Enter", 13), "Tab": ("Tab", 9),
                   "Space": (" ", 32), "ArrowDown": ("ArrowDown", 40)}
        key, vk = special.get(code, (code[3:].lower(), ord(code[-1]) if code.startswith("Key") else 0))
        check(vk != 0, "Unsupported key " + code)
        for kind in ("keyDown", "keyUp"):
            params = {"type": kind, "key": key, "code": code,
                      "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": modifiers}
            if kind == "keyDown" and code == "Enter" and modifiers == 0:
                params.update(text="\r", unmodifiedText="\r")
            self.cdp.call("Input.dispatchKeyEvent", params)
        self.frame()

    def shortcut(self, action):
        parts = self.report["keyboardDefaults"]["combos"][action]
        code = next(p for p in parts if p not in ("ctrl", "shift", "alt"))
        self.key(code, sum({"ctrl": 2, "shift": 8, "alt": 1}[p] for p in parts if p in ("ctrl", "shift", "alt")))

    def tab(self, tool):
        self.click('[data-tab-id="layout-tab-' + tool + '"]', "tab-" + tool)
        self.driver.wait_js(self.cdp, "[...document.querySelectorAll('[data-panel=\"" + tool + "\"]')].some(sessionsSmoke.visible)")
        # Actual mounted props/actions, not the panel's early data attribute.
        if tool in TOOLS:
            self.driver.wait_js(self.cdp, "sessionsSmoke.canvas().p." + {"crop": "isCropping", "masks": "isMasking", "ai": "isAiEditing"}[tool] + "&&sessionsSmoke.actions().some(a=>a.visible)")
        if tool in ("masks", "ai"):
            self.ensure_panel_heading(tool)

    def ensure_panel_heading(self, tool, timeout=60):
        row = {"tool": tool, "before": None, "beforeScroll": None, "after": None, "scrollAttempted": False, "passed": False}
        self.details.setdefault("panelHeadingChecks", []).append(row)
        expression = "sessionsSmoke.headingEvidence(" + json.dumps(tool) + ")"
        try:
            deadline = time.monotonic() + timeout
            while True:
                observed = self.js(expression)
                if row["before"] is None:
                    row["before"] = observed
                row["lastBeforeScroll"] = observed
                check(not observed["fatal"], str(observed["fatal"]))
                if observed["readyForScroll"]:
                    break
                check(time.monotonic() < deadline, "Current owned renderable heading did not mount: " + tool)
                self.frame()
                time.sleep(0.05)
            row["beforeScroll"] = observed
            row["scrollAttempted"] = True
            row["point"] = self.point("sessionsSmoke.panelHeading(" + json.dumps(tool) + ")", "panel-heading-" + tool)
            row["after"] = self.js(expression)
            check(not row["after"]["fatal"] and row["after"]["readyForScroll"] and row["after"]["visible"],
                  "Current tool heading is not visible after real DOM scrolling: " + tool)
            row["passed"] = True
        except Exception:
            row["error"] = traceback.format_exc()
            try:
                row["after"] = self.js(expression)
            except Exception:
                row["diagnosticError"] = traceback.format_exc()
            raise

    def persisted_tool_equal(self, expected, actual, tool):
        check(self.group == "switch-" + tool, "Persistence comparison is restricted to its switch_group")
        result = compare_persisted_tool(value(expected, tool), value(actual, tool), tool)
        records = self.details.setdefault("persistenceComparisons", [])
        if not records or records[-1] != result:
            records.append(result)
        return result["equal"]

    def action(self, name):
        self.click(ACTIONS + " " + ACTION.format(action=name), "action-" + name)

    def drag(self, expression, role, dx, dy, fx=0.5, fy=0.5):
        start = self.point(expression, role, fx, fy)
        self.mouse("mouseMoved", start, 0)
        self.mouse("mousePressed", start)
        try:
            for step in range(1, 9):
                self.mouse("mouseMoved", {"x": start["x"] + dx * step / 8, "y": start["y"] + dy * step / 8})
                self.frame()
        finally:
            self.mouse("mouseReleased", {"x": start["x"] + dx, "y": start["y"] + dy})
        self.frame()

    def record(self, suffix, action, predicate, expected, timeout=25, allowed=None):
        name = self.group + "/" + suffix
        check(expected and not any(c["name"] == name for c in self.report["cases"]), "Missing input plan or duplicate case")
        self.details = {}
        row = {"name": name, "group": self.group, "case": suffix, "passed": False, "expectedTrusted": expected}
        self.report["cases"].append(row)
        paths = allowed or [str(self.target)]
        self.js("document.querySelectorAll('[data-sessions-smoke-role]').forEach(n=>n.removeAttribute('data-sessions-smoke-role'));" +
                "sessionsSmoke.caseName=" + json.dumps(name) + ";sessionsSmoke.allowedPaths=" + json.dumps(paths))
        start_events, start_calls = self.js("[sessionsSmoke.events.length,sessionsSmoke.calls.length]")
        try:
            self.track()
            row["before"] = self.snapshot()
            action()
            deadline = time.monotonic() + timeout
            while True:
                self.frame()
                state = self.snapshot()
                check(state["path"] in paths, "Selection left authorized case paths")
                check(not state["observerErrors"], "Selection/observer errors")
                if state["path"] == str(self.target) and state["ready"] and predicate(state):
                    break
                check(time.monotonic() < deadline, "Result predicate timed out: " + name)
                time.sleep(0.05)
            self.track()
            row["state"] = state
            events = self.js("sessionsSmoke.events.slice(" + str(start_events) + ")")
            check(events and all(e["trusted"] and e["caseName"] == name for e in events), "Synthetic/misassigned events")
            for requirement in expected:
                check(any(all(e.get(k) == v for k, v in requirement.items()) for e in events), "Missing trusted event " + repr(requirement))
            check(not forbidden_calls(self.js("sessionsSmoke.calls.slice(" + str(start_calls) + ")")), "Forbidden native command")
            row["passed"] = True
            return state
        except Exception:
            row["error"] = traceback.format_exc()
            try:
                row["state"] = self.snapshot()
            except Exception:
                row["observationError"] = traceback.format_exc()
            raise
        finally:
            row["details"] = copy.deepcopy(self.details)
            try:
                row.update(events=self.js("sessionsSmoke.events.slice(" + str(start_events) + ")"),
                           calls=self.js("sessionsSmoke.calls.slice(" + str(start_calls) + ")"))
            except Exception:
                row["eventCollectionError"] = traceback.format_exc()
                row["passed"] = False

    def edit(self, tool):
        if tool == "crop":
            self.driver.wait_js(self.cdp, "sessionsSmoke.canvasNodes('.ReactCrop__drag-handle.ord-se').length===1", timeout=60)
            self.drag("sessionsSmoke.canvasOne('.ReactCrop__drag-handle.ord-se')", "crop-handle", -24, -16)
        else:
            self.ensure_panel_heading(tool)
            info = self.js("sessionsSmoke.brushInfo(" + json.dumps(tool) + ")")
            self.details["brushSelection"] = {"tool": tool, **info, "route": "actual existing ContainerRow/SubMaskRow" if info["existing"] else "actual Brush DraggableGridItem"}
            if info["existing"]:
                self.driver.wait_js(self.cdp, "sessionsSmoke.containerMounted(" + json.dumps(tool) + "," + json.dumps(info["containerId"]) + ")")
                self.click_expr("sessionsSmoke.brushContainer(" + json.dumps(tool) + ").nodes[0].firstElementChild", "brush-container")
                container_prop = "activeMaskContainerId" if tool == "masks" else "activeAiPatchContainerId"
                self.driver.wait_js(self.cdp, "sessionsSmoke.canvas().p." + container_prop + "===" + json.dumps(info["containerId"]))
                if not self.js("sessionsSmoke.brushContainer(" + json.dumps(tool) + ").p.isExpanded"):
                    expression = "sessionsSmoke.one('svg.lucide-folder',sessionsSmoke.brushContainer(" + json.dumps(tool) + ").nodes[0].firstElementChild,false).parentElement"
                    self.click_expr(expression, "brush-expand")
                self.driver.wait_js(self.cdp, "sessionsSmoke.brushContainer(" + json.dumps(tool) + ").p.isExpanded&&" +
                                    "sessionsSmoke.subMaskMounted(" + json.dumps(tool) + "," + json.dumps(info["id"]) + ")")
            else:
                self.driver.wait_js(self.cdp, "sessionsSmoke.brushTileMounted(" + json.dumps(tool) + ")")
            self.click_expr("sessionsSmoke.brushTarget(" + json.dumps(tool) + ")", "brush-select")
            sub_prop, container_prop = (("activeMaskId", "activeMaskContainerId") if tool == "masks" else ("activeAiSubMaskId", "activeAiPatchContainerId"))
            self.driver.wait_js(self.cdp, "(() => {const p=sessionsSmoke.canvas().p,info=sessionsSmoke.brushInfo(" + json.dumps(tool) + ");return info.existing&&" +
                                "p." + sub_prop + "===info.id&&p." + container_prop + "===info.containerId})()")
            self.driver.wait_js(self.cdp, "sessionsSmoke.drawingMounted()")
            self.drag("sessionsSmoke.drawing()", "drawing-canvas", 30, 18, 0.44, 0.44)
        # History is debounced in the real editor. Wait for idle before checking
        # undo, never fake history entries or call pushHistory.
        time.sleep(0.7)
        self.frame()

    def edit_case(self, suffix, tool):
        before = self.snapshot()
        def changed(r):
            if not active(r, tool) or value(r, tool) == value(before, tool) or not others_equal(r, before, tool) or not globals_equal(r, before):
                return False
            return tool == "crop" or (drawn_lines(r, tool) > drawn_lines(before, tool) and new_stroke(before, r, tool))
        return self.record(suffix, lambda: self.edit(tool), changed,
                           [req("pointerdown", "crop-handle" if tool == "crop" else "drawing-canvas"), req("pointermove"), req("pointerup")] +
                           ([] if tool == "crop" else [req("click", "brush-select")]))

    def select(self, photo):
        self.target = self.photos[photo]
        self.click_expr("sessionsSmoke.thumb(" + json.dumps(str(self.target)) + ")", "photo-" + photo)
        self.driver.wait_js(self.cdp, "sessionsSmoke.canvas().p.selectedImage.path===" + json.dumps(str(self.target)) +
                            "&&sessionsSmoke.canvas().p.selectedImage.isReady&&sessionsSmoke.canvas().p.hasRenderedFirstFrame", timeout=120)
        time.sleep(0.7)
        self.frame()

    def resize(self, width, height):
        samples = []
        win32gui.ShowWindow(self.hwnd, win32con.SW_RESTORE)
        for _ in range(8):
            before = self.js("({width:innerWidth,height:innerHeight})")
            outer, client = win32gui.GetWindowRect(self.hwnd), win32gui.GetClientRect(self.hwnd)
            samples.append({"viewport": before, "outer": outer, "client": client})
            if (before["width"], before["height"]) == (width, height):
                break
            sx, sy = (client[2] - client[0]) / before["width"], (client[3] - client[1]) / before["height"]
            win32gui.SetWindowPos(self.hwnd, None, 40, 40, outer[2] - outer[0] + round((width - before["width"]) * sx),
                                 outer[3] - outer[1] + round((height - before["height"]) * sy),
                                 win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)
            time.sleep(0.25)
            self.frame()
        actual = self.js("({width:innerWidth,height:innerHeight})")
        check((actual["width"], actual["height"]) == (width, height), "Native HWND resize did not settle")
        self.details["nativeResize"] = {"requested": [width, height], "actual": actual, "samples": samples}
        time.sleep(0.4)

    def recovery(self):
        self.js("sessionsSmoke.caseName='group-recovery';sessionsSmoke.allowedPaths=" + json.dumps([str(p) for p in self.photos.values()]))
        # Only trusted UI actions. Switching is Apply; never repair with stores.
        self.key("Escape") if self.js("!!document.querySelector('[role=dialog]')") else None
        self.resize(1280, 720)
        self.tab("presets")
        if self.snapshot()["path"] != str(self.photos["A"]):
            self.select("A")
        self.target = self.photos["A"]
        self.tab("curves")
        self.js("sessionsSmoke.allowedPaths=" + json.dumps([str(self.target)]))
        self.report["setup"].append({"kind": "trusted-group-recovery", "group": self.group, "state": self.snapshot()})

    def capture_client(self, tool):
        """Canonical desktop pixels, never a WebView-only CDP fallback."""
        import ctypes
        import io
        import win32api
        from PIL import ImageGrab
        time.sleep(0.4)
        self.frame()
        self.details["captureSettling"] = {"idleSeconds": 0.4, "animationFrames": 2, "productLatencyMeasurement": False}
        check(self.process.poll() is None and win32process.GetWindowThreadProcessId(self.hwnd)[1] == self.process.pid,
              "Desktop capture requires live owned HWND")
        if win32gui.GetForegroundWindow() != self.hwnd:
            win32gui.SetForegroundWindow(self.hwnd)
        deadline = time.monotonic() + 3
        while win32gui.GetForegroundWindow() != self.hwnd and time.monotonic() < deadline:
            time.sleep(0.05)
        check(win32gui.GetForegroundWindow() == self.hwnd, "Owned HWND is not foreground for capture")
        viewport = self.js("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})")
        check((viewport["width"], viewport["height"]) == (1280, 720), "Canonical capture requires real 1280x720 viewport")
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        user32.GetDpiForWindow.argtypes, user32.GetDpiForWindow.restype = [ctypes.c_void_p], ctypes.c_uint
        previous = user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        check(previous is not None, "Cannot establish physical per-monitor capture coordinates")
        try:
            client = win32gui.GetClientRect(self.hwnd)
            size = (client[2] - client[0], client[3] - client[1])
            check(size == (1280, 720), "Canonical capture needs physical 1280x720 client, got " + repr(size))
            origin = win32gui.ClientToScreen(self.hwnd, (0, 0))
            bbox = (origin[0], origin[1], origin[0] + size[0], origin[1] + size[1])
            screen = (win32api.GetSystemMetrics(76), win32api.GetSystemMetrics(77),
                      win32api.GetSystemMetrics(78), win32api.GetSystemMetrics(79))
            check(bbox[0] >= screen[0] and bbox[1] >= screen[1] and bbox[2] <= screen[0] + screen[2] and
                  bbox[3] <= screen[1] + screen[3], "Owned client is clipped outside virtual screen")
            image = ImageGrab.grab(bbox=bbox, all_screens=True)
            check(image.size == size and win32gui.GetForegroundWindow() == self.hwnd and self.process.poll() is None and
                  win32process.GetWindowThreadProcessId(self.hwnd)[1] == self.process.pid,
                  "Client capture dimensions/foreground/ownership changed")
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            data = buffer.getvalue()
            capture = {"method": "PIL.ImageGrab/owned-Windows-client", "bbox": bbox, "clientPixels": size,
                       "viewport": viewport, "dpi": user32.GetDpiForWindow(self.hwnd), "coordinateMode": "PER_MONITOR_AWARE_V2",
                       "foregroundOwned": True, "clipped": False, "virtualScreen": screen,
                       "pixelScope": "Visible owned client including native composition; capture alone does not certify GPU image colors or model quality"}
        finally:
            check(user32.SetThreadDpiAwarenessContext(previous) is not None, "Cannot restore capture thread DPI context")
        path = OUT / ("geometry-" + tool + "-1280x720.png")
        with path.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        check(path.read_bytes() == data, "Canonical PNG readback mismatch")
        row = {"tool": tool, "caseName": self.group + "/resize-back", "path": str(path), "sha256": sha(path),
               "bytes": len(data), "capture": capture}
        self.details["screenshot"] = row
        self.report.setdefault("canonicalScreenshots", []).append(row)


def session_group(s, tool):
    entry = s.snapshot()  # Capture BEFORE entry: crop projection may round 1px.
    s.record("enter", lambda: s.tab(tool), lambda r: active(r, tool), [req("click", "tab-" + tool)])
    s.edit_case("edit", tool)
    before = s.snapshot()
    current = before["exposure"]
    check(isinstance(current, (int, float)), "Owning Basic exposure unavailable")
    s.record("slider", lambda: s.click(RIGHT + ' [data-speed-edit-id="exposure"] input[type="range"]', "exposure", 0.67 if current < 0.5 else 0.34),
             lambda r: active(r, tool) and r["exposure"] != current and r["curves"] == before["curves"] and
             r["curveMode"] == before["curveMode"] and all(value(r, k) == value(before, k) for k in TOOLS),
             [req("pointerdown", "exposure"), req("pointerup", "exposure")])
    before = s.snapshot()
    s.record("curve", lambda: s.click_expr("sessionsSmoke.graph()", "global-curve", 0.27 + TOOLS.index(tool) * 0.11, 0.23),
             lambda r: active(r, tool) and r["curves"] != before["curves"] and r["exposure"] == before["exposure"] and
             all(value(r, k) == value(before, k) for k in TOOLS),
             [req("mousedown", "global-curve"), req("mouseup", "global-curve")])
    edited = s.snapshot()
    s.record("cancel", lambda: s.action("cancel"),
             lambda r: active(r, "presets") and value(r, tool) == value(entry, tool) and globals_equal(r, edited) and others_equal(r, edited, tool),
             [req("click", "action-cancel")])
    s.record("undo", lambda: s.shortcut("undo"),
             lambda r: value(r, tool) == value(edited, tool) and globals_equal(r, edited) and others_equal(r, edited, tool),
             [req("keydown", code=s.report["keyboardDefaults"]["codes"]["undo"]), req("keyup", code=s.report["keyboardDefaults"]["codes"]["undo"])])
    # Enter each session from ordinary mode even if undo restores tool UI.
    s.tab("presets")
    for prefix, apply_action, inputs in (("apply", lambda: s.action("apply"), [req("click", "action-apply")]),
                                         ("enter", lambda: s.key("Enter"), [req("keydown", code="Enter"), req("keyup", code="Enter")])):
        s.record(prefix + "-reenter", lambda: s.tab(tool), lambda r: active(r, tool), [req("click", "tab-" + tool)])
        kept = s.edit_case(prefix + "-edit", tool)
        if prefix == "enter":
            # Last event was drawing, so keyboard focus must leave any input.
            check(s.snapshot()["focus"]["tag"] not in ("INPUT", "TEXTAREA"), "Enter test still has text-input focus")
        s.record("apply" if prefix == "apply" else "enter-keep", apply_action,
                 lambda r, kept=kept: active(r, "presets") and value(r, tool) == value(kept, tool) and globals_equal(r, kept) and others_equal(r, kept, tool), inputs)
    s.record("tool-switch-enter", lambda: s.tab(tool), lambda r: active(r, tool), [req("click", "tab-" + tool)])
    kept = s.edit_case("tool-switch-edit", tool)
    other = "masks" if tool == "crop" else "crop"
    s.record("tool-switch-keep", lambda: s.tab(other), lambda r: active(r, other) and value(r, tool) == value(kept, tool) and globals_equal(r, kept), [req("click", "tab-" + other)])


def switch_group(s, tool):
    # Baseline B is observed through real selection before entering the tool.
    # This is an explicitly bounded setup phase, outside measured cases. Its
    # real B->A clicks need both fixture paths until A is ready again. Never
    # clear observer errors, broaden measured paths, or authorize unknown paths.
    phase = s.group + "/baseline-navigation"
    setup = {"kind": "trusted-baseline-navigation", "phase": phase, "group": s.group,
             "allowedPaths": [str(p) for p in s.photos.values()], "restoreAllowedPaths": [str(s.photos["A"])], "passed": False}
    s.report["setup"].append(setup)
    start = s.js("sessionsSmoke.events.length")
    s.js("sessionsSmoke.caseName=" + json.dumps(phase) + ";sessionsSmoke.allowedPaths=" + json.dumps(setup["allowedPaths"]))
    try:
        s.select("B")
        b_entry = s.snapshot()
        s.select("A")
        state = s.snapshot()
        check(state["path"] == str(s.photos["A"]) and state["ready"] and state["rendered"], "Baseline setup did not return to ready rendered A")
        check(not state["observerErrors"], "Observer errors during baseline setup")
        events = s.js("sessionsSmoke.events.slice(" + str(start) + ")")
        check(events and all(e["trusted"] and e["caseName"] == phase for e in events), "Baseline setup has synthetic/misassigned input")
        check(all(any(e["type"] == "click" and e["role"] == "photo-" + ident for e in events) for ident in ("B", "A")), "Missing real baseline B/A clicks")
        setup.update(passed=True, returnedTo={"path": state["path"], "ready": state["ready"], "rendered": state["rendered"]})
    finally:
        s.js("sessionsSmoke.allowedPaths=" + json.dumps([str(s.photos["A"])]))
        setup["events"] = s.js("sessionsSmoke.events.slice(" + str(start) + ")")
    s.record("enter-a", lambda: s.tab(tool), lambda r: active(r, tool), [req("click", "tab-" + tool)])
    a_edited = s.edit_case("edit-a", tool)
    s.target = s.photos["B"]
    b_ready = s.record("a-to-b", lambda: s.select("B"),
                       lambda r: active(r, tool) and s.persisted_tool_equal(b_entry, r, tool) and globals_equal(r, b_entry),
                       [req("click", "photo-B")], timeout=120, allowed=[str(p) for p in s.photos.values()])
    check(value(b_ready, tool) != value(a_edited, tool), "Cross-image cancellation control must have distinct A/B tool data")
    b_edited = s.edit_case("edit-b", tool)
    s.record("cancel-b", lambda: s.action("cancel"),
             lambda r: active(r, "presets") and value(r, tool) == value(b_entry, tool) and globals_equal(r, b_edited) and others_equal(r, b_edited, tool),
             [req("click", "action-cancel")])
    s.target = s.photos["A"]
    s.record("return-a", lambda: s.select("A"),
             lambda r: s.persisted_tool_equal(a_edited, r, tool) and globals_equal(r, a_edited),
             [req("click", "photo-A")], timeout=120, allowed=[str(p) for p in s.photos.values()])
    s.target = s.photos["B"]
    s.record("return-b", lambda: s.select("B"),
             lambda r: s.persisted_tool_equal(b_entry, r, tool) and globals_equal(r, b_edited),
             [req("click", "photo-B")], timeout=120, allowed=[str(p) for p in s.photos.values()])


def focus_cancel(s):
    # Keyboard focus only: no .focus(), callback, DOM click or settings setter.
    for step in range(100):
        s.key("Tab")
        if s.js("document.activeElement?.getAttribute('data-tool-session-action')==='cancel'"):
            s.details["tabSteps"] = step + 1
            return
    raise RuntimeError("Cannot reach Cancel via actual Tab navigation")


def keyboard_group(s, tool):
    entry = s.snapshot()
    s.record("enter", lambda: s.tab(tool), lambda r: active(r, tool), [req("click", "tab-" + tool)])
    edited = s.edit_case("edit", tool)
    s.record("focus-cancel", lambda: focus_cancel(s), lambda r: active(r, tool) and r["focus"]["action"] == "cancel",
             [req("keydown", code="Tab"), req("focusin")])
    s.record("focused-enter-cancels", lambda: s.key("Enter"),
             lambda r: active(r, "presets") and value(r, tool) == value(entry, tool) and globals_equal(r, edited),
             [{"type": "keydown", "code": "Enter", "action": "cancel"}, {"type": "click", "action": "cancel"}])
    escape_entry = s.snapshot()
    s.record("escape-enter", lambda: s.tab(tool), lambda r: active(r, tool), [req("click", "tab-" + tool)])
    escape_edited = s.edit_case("escape-edit", tool)
    if tool != "crop":
        sub, container = (("mask", "maskContainer") if tool == "masks" else ("ai", "aiContainer"))
        check(escape_edited["selection"][sub] and escape_edited["selection"][container], "Esc hierarchy requires selected submask and container")
        s.record("escape-submask", lambda: s.key("Escape"),
                 lambda r: active(r, tool) and r["selection"][sub] is None and r["selection"][container] == escape_edited["selection"][container] and
                 value(r, tool) == value(escape_edited, tool), [req("keydown", code="Escape"), req("keyup", code="Escape")])
        s.record("escape-container", lambda: s.key("Escape"),
                 lambda r: active(r, tool) and r["selection"][sub] is None and r["selection"][container] is None and
                 value(r, tool) == value(escape_edited, tool), [req("keydown", code="Escape"), req("keyup", code="Escape")])
    s.record("escape-cancels", lambda: s.key("Escape"),
             lambda r: active(r, "presets") and value(r, tool) == value(escape_entry, tool) and globals_equal(r, escape_edited),
             [req("keydown", code="Escape"), req("keyup", code="Escape")])
    # AI's existing prompt Enter explicitly starts generation. Cover its focus
    # isolation only in a separately labeled browser host with generation mocked.
    if tool == "masks":
        s.record("rename-enter", lambda: (s.tab(tool), s.edit(tool)), lambda r: active(r, tool) and drawn_lines(r, tool) > 0,
                 [req("click", "tab-masks"), req("pointerup")])
        before = s.snapshot()
        renamed = copy.deepcopy(before["masks"])
        for container in renamed:
            if container["id"] == before["selection"]["maskContainer"]:
                container["name"] = "Smoke renamed mask"
        def rename():
            root = "sessionsSmoke.one('[data-panel=masks]')"
            expression = "sessionsSmoke.component(p=>p?.container?.id===" + json.dumps(before["selection"]["maskContainer"]) + \
                         "&&typeof p.updateContainer==='function'&&typeof p.onToggle==='function'," + root + ").nodes[0].firstElementChild"
            header = expression
            point = s.point(expression, "mask-row")
            s.mouse("mouseMoved", point, 0)
            s.mouse("mousePressed", point, 2, "right")
            s.mouse("mouseReleased", point, 0, "right")
            s.frame()
            s.click_expr("(() => {const all=[...sessionsSmoke.one('[role=menu]').querySelectorAll('button[role=menuitem]')].filter(n=>n.textContent.trim()==='Rename'&&sessionsSmoke.visible(n));" +
                         "if(all.length!==1||!sessionsSmoke.props(all[0],p=>p?.option?.label==='Rename'&&typeof p.hideContextMenu==='function'))throw Error('Missing current Rename MenuItem');return all[0];})()", "rename-menu")
            # Scope to the exact ContainerRow title, excluding the panel's
            # many range/number inputs. No weakened global input predicate.
            expression = "sessionsSmoke.one('input',(" + header + "),false)"
            s.click_expr(expression, "mask-rename")
            s.key("KeyA", 2)
            s.cdp.call("Input.insertText", {"text": "Smoke renamed mask"})
            s.key("Enter")
        s.record("rename-input-enter", rename,
                 lambda r: active(r, tool) and r["masks"] == renamed and globals_equal(r, before) and others_equal(r, before, tool),
                 [req("contextmenu", "mask-row"), req("input", "mask-rename"), req("keydown", "mask-rename", "Enter")])


def assert_layout(s, tool):
    evidence = s.js("sessionsSmoke.layout()")
    s.details["geometry"] = evidence
    bar, viewport, overlay = (evidence[k] for k in ("bar", "viewport", "overlay"))
    check(bar["width"] > 0 and bar["height"] > 0 and bar["top"] >= viewport["bottom"] - 1 and
          bar["top"] >= overlay["bottom"] - 1, "Buttons overlay actual canvas or portal")
    check(abs(bar["left"] - viewport["left"]) <= 1 and abs(bar["width"] - viewport["width"]) <= 1,
          "Action bar is not aligned to actual canvas width")
    check(all(abs(viewport[k] - overlay[k]) <= 1 for k in ("left", "top", "width", "height")), "Canvas/portal viewport rectangles disagree")
    check(all(b["visible"] and not b["disabled"] for b in evidence["buttons"]), "Missing/disabled visible actions")
    if tool == "crop":
        check(len(evidence["frames"]) == 1 and len(evidence["selections"]) == 1, "Missing current crop frame/selection")
        frame, selection = evidence["frames"][0]["rect"], evidence["selections"][0]
        check(frame["width"] > 0 and frame["height"] > 0 and selection["bottom"] <= bar["top"] + 1,
              "Crop lower edge is blocked by action bar")
        check(frame["left"] >= overlay["left"] - 2 and frame["top"] >= overlay["top"] - 2 and
              frame["right"] <= overlay["right"] + 2 and frame["bottom"] <= overlay["bottom"] + 2, "Crop frame outside overlay")
        # At reset view (no zoom/rotate), projector image rectangle must match
        # the crop frame. No tolerance beyond 2 CSS pixels for rounding.
        images = [i for i in evidence["images"] if all(abs(i["rect"][k] - frame[k]) <= 2 for k in ("left", "top", "width", "height"))]
        check(len(evidence["images"]) == 1 and len(images) == 1, "Crop frame is not aligned to the unique real Crop preview image")
        draft = evidence["draft"]
        check(isinstance(draft, dict) and draft.get("unit") in ("%", "px"), "Missing actual crop draft")
        fx = frame["width"] / 100 if draft["unit"] == "%" else 1
        fy = frame["height"] / 100 if draft["unit"] == "%" else 1
        projected = {"left": frame["left"] + draft["x"] * fx, "top": frame["top"] + draft["y"] * fy,
                     "width": draft["width"] * fx, "height": draft["height"] * fy}
        s.details["geometry"]["projectedCrop"] = projected
        check(all(abs(selection[k] - projected[k]) <= 2 for k in projected), "Selection not aligned with current draft after resize")
    return True


def geometry_group(s, tool):
    s.record("enter", lambda: s.tab(tool), lambda r: active(r, tool), [req("click", "tab-" + tool)])
    def layout_click():
        # Real trusted input on a harmless panel tab, plus strict geometry proof.
        s.tab("curves")
        assert_layout(s, tool)
    s.record("layout", layout_click, lambda r: active(r, tool), [req("click", "tab-curves")])
    before = s.snapshot()
    for suffix, width, height in (("resize-small", 1000, 650), ("resize-back", 1280, 720)):
        def resize(width=width, height=height):
            s.resize(width, height)
            s.tab("curves")
            assert_layout(s, tool)
            if (width, height) == (1280, 720):
                s.capture_client(tool)
        s.record(suffix, resize,
                 lambda r, width=width, height=height: active(r, tool) and r["viewport"]["width"] == width and r["viewport"]["height"] == height and
                 value(r, tool) == value(before, tool), [req("click", "tab-curves")])
    s.record("exit", lambda: s.action("apply"), lambda r: active(r, "presets"), [req("click", "action-apply")])


def forbidden_calls(calls):
    return [c["command"] for c in calls if c["command"] == "export_images" or re.search(
        r"download|generate_ai_|generate_full_image_depth_map|generate_relight_normal_map|inpaint|generative_replace|quick_erase|precompute_ai_|generate_(?:liquify|retouch|manual_cleanup)_patch", c["command"], re.I)]


def keyboard_defaults():
    path = ROOT / "keyboardUtils.ts"
    text = path.read_text(encoding="utf-8-sig")
    combos, codes = {}, {}
    for action in ("undo", "toggle_adjustments"):
        match = re.search(r"action:\s*'" + action + r"'\s*,[\s\S]*?defaultCombo:\s*\[([^]]*)\]", text)
        check(match is not None, "Cannot read keybind " + action)
        parts = re.findall(r"'([^']+)'", match.group(1))
        nonmods = [p for p in parts if p not in ("ctrl", "shift", "alt")]
        check(len(nonmods) == 1, "Unsupported keybind " + action)
        combos[action], codes[action] = parts, nonmods[0]
    return {"sha256": sha(path), "combos": combos, "codes": codes}


def seed_settings():
    folder = str(ROOT / "fixture")
    return {"language": "en", "decorations": False, "keybinds": {}, "aiProvider": "cpu", "enableXmpSync": False,
            "createXmpIfMissing": False, "rootFolders": [folder], "lastRootPath": folder,
            "grouping": "off", "libraryViewMode": "recursive",
            "uiVisibility": {"leftPanel": True, "rightPanel": True, "filmstrip": True, "quickFilter": False},
            "lastFolderState": {"currentFolderPath": folder, "expandedFolders": [folder], "activeAlbumId": None, "expandedAlbumGroups": []},
            "adjustmentLayout": {"openSections": {"basic": True, "curves": True, "color": True, "details": True, "effects": True}},
            "workspace": {"leftPanelWidth": 300, "rightPanelWidth": 320, "leftTopHeight": 340, "rightTopHeight": 450,
                          "panelLayout": {}, "activePanels": {}, "panelSwitcherPlacement": {}}}


def validate_browser(report):
    """External browser records supplement, NEVER stand in for native edits.

    Parent writes {scriptSha256,exeSha256,artifact:{path,sha256,bytes}}.
    Artifact: {notnativegeneration:true,cases:[{name,passed:true,
    source:'browser-simulated-editorflag',setup:{flag,value:true},
    assertions:{applyDisabled:true,cancelDisabled:true,enterBlocked:true,
                toolDataUnchanged:true,modeUnchanged:true},events:[...]}]}.
    Each case requires trusted keydown/keyup Enter. For new-image-not-ready,
    setup.flag='selectedImage.isReady', value=false; busy names bind flag.
    ai-prompt-enter uses source='browser-mocked-generation',
    setup={flag:'prompt-focused',value:true}; its assertions are
    inputFocused,modeUnchanged,sharedApplyNotCalled,nativeGenerationNotInvoked.
    It must include trusted input and Enter targeted at an input/textarea.
    The artifact may be the browser runner's .json.gz, with status='passed'
    and nativeSupplement. Compressed sha256/bytes bind that exact file; optional
    rawSha256 additionally binds decompressed bytes. Full runner evidence must
    be parentFrozen, sourceUnchanged, cleanly stopped, and hash this controller.
    No full settings, secrets or raw authentication are permitted in artifacts.
    """
    path = ROOT / "browser-coverage.json"
    if not path.exists():
        report["pendingBrowserCoverage"] = list(BROWSER_REQUIRED)
        return False
    check(not path.is_symlink(), "Browser manifest symlink")
    manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    check(all(manifest.get(k) == report[k] for k in ("scriptSha256", "exeSha256")), "Browser coverage script/EXE binding mismatch")
    ref = manifest["artifact"]
    artifact = relative_file(ref["path"])
    check(artifact.is_file() and artifact.stat().st_size == ref["bytes"] and sha(artifact) == ref["sha256"], "Browser artifact identity mismatch")
    encoded = artifact.read_bytes()
    decoded = gzip.decompress(encoded) if artifact.name.endswith(".json.gz") else encoded
    check("rawSha256" not in ref or hashlib.sha256(decoded).hexdigest() == ref["rawSha256"], "Browser raw hash mismatch")
    raw = json.loads(decoded.decode("utf-8-sig"))
    # Parent may reference the complete immutable browser raw file; extraction
    # is structural only, never rewriting its failures/events/assertions.
    if "nativeSupplement" in raw:
        check(raw.get("passed") is True or raw.get("status") == "passed", "Complete browser raw did not pass")
        if "status" in raw:
            check(raw["status"] == "passed" and not raw.get("errors") and raw.get("environment", {}).get("parentFrozen") is True,
                  "Browser runner was not a clean frozen full run")
            provenance = raw.get("provenance", {})
            check(provenance.get("sourceUnchanged") is True and
                  provenance.get("before", {}).get("files", {}).get("checks/tool-sessions/windows-smoke.py") == report["scriptSha256"],
                  "Browser runner did not bind unchanged controller source")
            check(all(raw.get("cleanup", {}).get(k) is True for k in ("browserClosed", "viteExited", "pidGone", "portReleased")),
                  "Browser runner cleanup did not pass")
            check(raw.get("cases") and all(c.get("status") == "passed" and all(s.get("status") == "passed" for s in c.get("steps", []))
                                           for c in raw["cases"]), "Browser raw retains failed cases/steps")
    check(raw.get("passed", True) is True, "Browser artifact reports failure")
    data = raw.get("nativeSupplement", raw)
    check(isinstance(data, dict), "Invalid nativeSupplement")
    check(data.get("notnativegeneration") is True, "Browser flags must be labeled notnativegeneration")
    check(data.get("complete", True) is True and not data.get("missing"), "Browser supplement incomplete")
    rows = data.get("cases")
    check(isinstance(rows, list) and all(isinstance(c, dict) for c in rows), "Invalid browser cases")
    check(len({c.get("name") for c in rows}) == len(rows) and all(c.get("passed") is True for c in rows), "Duplicate/failed browser case")
    by_name = {c["name"]: c for c in rows}
    for name in BROWSER_REQUIRED:
        row = by_name.get(name)
        check(row, "Missing browser case " + name)
        if name == "ai-prompt-enter":
            check(row.get("source") == "browser-mocked-generation" and row.get("setup") == {"flag": "prompt-focused", "value": True}, "Prompt browser source mismatch")
            check(all(row.get("assertions", {}).get(k) is True for k in
                      ("inputFocused", "modeUnchanged", "sharedApplyNotCalled", "nativeGenerationNotInvoked")), "Prompt focus assertions incomplete")
            events = row.get("events", [])
            check(events and all(e.get("trusted") is True for e in events) and any(e.get("type") == "input" for e in events), "Missing trusted prompt input")
            check(all(any(e.get("type") == kind and e.get("code") == "Enter" and e.get("tag") in ("INPUT", "TEXTAREA") for e in events)
                      for kind in ("keydown", "keyup")), "Prompt Enter target is not input")
            continue
        check(row.get("source") == "browser-simulated-editorflag", "Missing browser flag source " + name)
        flag = "selectedImage.isReady" if name == "new-image-not-ready" else name.split("-", 2)[2]
        check(row.get("setup") == {"flag": flag, "value": name != "new-image-not-ready"}, "Browser case flag mismatch")
        assertions = row.get("assertions", {})
        check(all(assertions.get(k) is True for k in ("applyDisabled", "cancelDisabled", "enterBlocked", "toolDataUnchanged", "modeUnchanged")),
              "Incomplete browser assertions " + name)
        events = row.get("events", [])
        check(events and all(e.get("trusted") is True for e in events), "Untrusted browser input")
        check(all(any(e.get("type") == kind and e.get("code") == "Enter" for e in events) for kind in ("keydown", "keyup")), "Missing browser Enter input")
    report.update(browserCoverage={"sources": ["browser-simulated-editorflag", "browser-mocked-generation"], "notnativegeneration": True,
                                   "manifestSha256": sha(path), "artifact": ref, "passedCases": list(BROWSER_REQUIRED)}, pendingBrowserCoverage=[])
    return True


def main():
    global win32gui, win32con, win32process
    # Refusals never overwrite an earlier attempt or private recovery backup.
    check(not OUTPUT.exists() and not OUTPUT.is_symlink(), "Refuse existing evidence/windows-smoke.json")
    check(not (ROOT / "profile-backup").exists() and not (ROOT / "profile-backup").is_symlink(), "Refuse existing private backup")
    check(not (ROOT / "output").exists() and not (ROOT / "fixture/output").exists(), "Refuse fixture output directory")
    OUT.mkdir(parents=True, exist_ok=True)
    evidence = OUTPUT.open("x", encoding="utf-8")
    plan = expected_cases()
    report = {"schema": "rapidraw-tool-sessions-windows-smoke-v1", "started": stamp(), "scriptSha256": sha(Path(__file__)),
              "passed": False, "nativePassed": False, "coverageComplete": False, "cleanupPassed": False, "publicationEligible": False,
              "parentVisualReviewRequired": True, "canonicalScreenshots": [],
              "publicationGate": "Parent must read all three canonical PNGs after the run and supply a separate passed agent review JSON bound to report/script/EXE/PNG hashes; not human acceptance",
              "setup": [], "groups": [], "cases": [], "plannedGroups": list(GROUPS), "plannedCases": plan,
              "pendingBrowserCoverage": list(BROWSER_REQUIRED), "launchAttempted": False, "ownedTreeShutdownVerified": False,
              "limits": ["Static authoring is not a Windows execution.", "No native generation/model/download validation.",
                         "Busy and deterministic !ready coverage use separately identified browser flag simulations.",
                         "Geometry proves DOM image projector/crop/action alignment, not native WGPU pixel colors or human ergonomics.",
                         "Only isolated NASA RAW copies are edited; private profile backup never belongs in published evidence."]}
    original, photos = {}, {}
    process = cdp = s = None
    hwnd = root_token = None
    quiet = mutated = launch_attempted = False
    measured_ok = browser_ok = False
    try:
        check(os.name == "nt", "Parent must execute in interactive Windows desktop")
        import win32con
        import win32gui
        import win32process
        check(EXE.is_file() and not EXE.is_symlink(), "Stage RapidRAW-sessions.exe")
        windows = []
        win32gui.EnumWindows(lambda h, _: windows.append(h) if win32gui.GetWindowText(h) == TITLE else None, None)
        check(not windows, "Close existing TBT windows before touching profile")
        check(not any(re.fullmatch(r"rapidraw(?:-[\w-]+)?\.exe", p["exe"], re.I) for p in process_table().values()),
              "A RapidRAW process is already running, including hidden windows")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 9431))
        quiet = True
        report["quietPreflightVerified"] = True
        for name, frozen in FROZEN.items():
            check((ROOT / name).is_file() and not (ROOT / name).is_symlink() and sha(ROOT / name) == frozen, "Frozen helper changed: " + name)
        report["baselineHashes"] = dict(FROZEN)
        report["exeSha256"] = sha(EXE)
        photos = load_fixtures(report)
        report["keyboardDefaults"] = keyboard_defaults()
        config = Path(os.environ["APPDATA"]) / "io.github.tursom.RapidRAW"
        for path in (config / "settings.json", config / "window_state.json"):
            check(not path.is_symlink(), "Refuse linked profile file")
            original[path] = path.read_bytes() if path.exists() else None
        backup_profiles(original, report)
        spec = importlib.util.spec_from_file_location("tool_sessions_frozen_driver", ROOT / "windows-cdp.py")
        driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(driver)
        driver.ROOT, driver.OUT, driver.EXE = ROOT, OUT, EXE
        (ROOT / "logs").mkdir(exist_ok=True)
        config.mkdir(parents=True, exist_ok=True)
        mutated = True
        (config / "settings.json").write_text(json.dumps(seed_settings()), encoding="utf-8")
        report["setup"].append({"kind": "profile-seed", "aiProvider": "cpu", "noModelGeneration": True})
        launch_attempted = report["launchAttempted"] = True
        process, cdp, timing = driver.launch()
        root_token = process_token(process.pid)
        check(root_token is not None, "Root exited before ownership capture")
        handles = []
        win32gui.EnumWindows(lambda h, _: handles.append(h) if win32process.GetWindowThreadProcessId(h)[1] == process.pid and
                             win32gui.IsWindowVisible(h) and win32gui.GetWindowText(h) == TITLE else None, None)
        check(len(handles) == 1, "Expected one owned TBT HWND")
        hwnd = handles[0]
        report.update(launch=timing, browser=cdp.call("Browser.getVersion"))
        s = Smoke(driver, process, cdp, hwnd, root_token, photos, report)
        driver.wait_js(cdp, "[...document.querySelectorAll('button')].some(n=>/Continue Session/i.test(n.innerText))")
        s.js((ROOT / "observe.js").read_text(encoding="utf-8"))
        s.js(OBSERVER_JS)
        report["observerProbe"] = s.js("sessionsSmoke.probe()")
        # Setup library navigation only. All measured cases below use trusted Input.
        report["setup"].append({"kind": "synthetic-library-navigation", "measured": False})
        s.js("[...document.querySelectorAll('button')].find(n=>/Continue Session/i.test(n.innerText)).click()")
        driver.wait_js(cdp, "baseline.thumbnailCoverage().expected===2&&baseline.thumbnailCoverage().missing===0", timeout=120)
        s.js("document.querySelector('[data-bench-id=thumbnail]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
        driver.wait_js(cdp, "(() => {try{return sessionsSmoke.canvas().p.selectedImage.isReady&&sessionsSmoke.canvas().p.hasRenderedFirstFrame}catch{return false}})()", timeout=120)
        s.js("sessionsSmoke.allowedPaths=" + json.dumps([str(p) for p in photos.values()]) + ";sessionsSmoke.armed=true")
        runners = {"session": session_group, "switch": switch_group, "keyboard": keyboard_group, "geometry": geometry_group}
        for group in GROUPS:
            s.group = group
            row = {"name": group, "passed": False}
            report["groups"].append(row)
            start = len(report["cases"])
            try:
                s.recovery()
                prefix, tool = group.split("-", 1)
                runners[prefix](s, tool)
                rows = report["cases"][start:]
                check({c["case"] for c in rows} == set(plan[group]) and len(rows) == len(plan[group]) and all(c["passed"] for c in rows), "Incomplete group plan")
                row["passed"] = True
            except Exception:
                row["error"] = traceback.format_exc()
            row["caseNames"] = [c["name"] for c in report["cases"][start:]]
        measured_ok = len(report["groups"]) == len(GROUPS) and all(g["passed"] for g in report["groups"]) and all(c["passed"] for c in report["cases"])
        check(len(report["canonicalScreenshots"]) == 3 and {c["tool"] for c in report["canonicalScreenshots"]} == set(TOOLS),
              "All three canonical owned-client captures are required")
        browser_ok = validate_browser(report)
    except Exception:
        report["error"] = traceback.format_exc()
    finally:
        errors = []
        if cdp is not None:
            try:
                cdp.js("sessionsSmoke.assertHook()")
                report["finalObservation"] = cdp.js("({hook:sessionsSmoke.hookStatus(),calls:sessionsSmoke.calls,events:sessionsSmoke.events,errors:sessionsSmoke.errors,transitions:sessionsSmoke.transitions,notReadySamples:sessionsSmoke.notReadySamples})")
                final = report["finalObservation"]
                check(not final["errors"] and not forbidden_calls(final["calls"]), "Forbidden commands or observation errors")
                for sample in final["notReadySamples"]:
                    check(len(sample["actions"]) == 1 and all(b["disabled"] for b in sample["actions"][0]["buttons"]), "!ready actions were not disabled")
            except Exception:
                report["finalObservationError"] = traceback.format_exc()
                measured_ok = False
            try:
                cdp.close()
            except Exception:
                errors.append("CDP close: " + traceback.format_exc())
        try:
            if process is not None and root_token is not None:
                stop_tree(process, hwnd, root_token, s.known if s else {}, report)
        except Exception:
            errors.append("Owned shutdown: " + traceback.format_exc())
        stopped = (report["ownedTreeShutdownVerified"] is True if launch_attempted else quiet)
        report["processStopped"] = stopped
        if mutated and stopped:
            for path, data in original.items():
                try:
                    if data is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_bytes(data)
                except Exception:
                    errors.append("Profile restore " + path.name + ": " + traceback.format_exc())
        elif mutated:
            errors.append("Profile restoration withheld: entire owned tree shutdown unverified; use private local backup after parent recovery")
        try:
            report["profileRestored"] = bool(original) and stopped and all((p.read_bytes() if p.exists() else None) == data for p, data in original.items())
            report["profileAfter"] = [{"file": p.name, "existed": p.exists(), "sha256": sha(p) if p.exists() else None} for p in original]
        except Exception:
            report["profileRestored"] = False
            errors.append("Profile readback: " + traceback.format_exc())
        try:
            report["rawAfter"] = {k: sha(p) for k, p in photos.items()}
            report["rawBytesUnchanged"] = len(photos) == 2 and all(sha(p) == NASA[k][2] and p.stat().st_size == NASA[k][3] for k, p in photos.items())
            report["baselineUnchanged"] = all(sha(ROOT / name) == frozen for name, frozen in FROZEN.items())
            report["exeUnchanged"] = sha(EXE) == report.get("exeSha256")
            report["scriptUnchanged"] = sha(Path(__file__)) == report["scriptSha256"]
            report["keyboardSourceUnchanged"] = sha(ROOT / "keyboardUtils.ts") == report.get("keyboardDefaults", {}).get("sha256")
            report["fixtureManifestUnchanged"] = sha(Path(report["fixtureManifestPath"])) == report.get("fixtureManifestSha256")
            report["canonicalScreenshotsUnchanged"] = len(report["canonicalScreenshots"]) == 3 and all(
                not Path(c["path"]).is_symlink() and sha(Path(c["path"])) == c["sha256"] and Path(c["path"]).stat().st_size == c["bytes"]
                for c in report["canonicalScreenshots"])
        except Exception:
            errors.append("Immutable input verification: " + traceback.format_exc())
        report["cleanupErrors"] = errors
        report["cleanupPassed"] = bool(stopped and report.get("profileRestored") and report.get("rawBytesUnchanged") and
                                       report.get("baselineUnchanged") and report.get("exeUnchanged") and report.get("scriptUnchanged") and
                                       report.get("keyboardSourceUnchanged") and report.get("fixtureManifestUnchanged") and
                                       report.get("canonicalScreenshotsUnchanged") and not errors)
        report["nativePassed"] = bool(measured_ok and not report.get("error"))
        report["coverageComplete"] = bool(report["nativePassed"] and browser_ok and not report["pendingBrowserCoverage"])
        report["passed"] = report["coverageComplete"] and report["cleanupPassed"]
        # The immutable native report intentionally does not self-approve the
        # parent's later visual review. Its separate hash-bound JSON is needed
        # alongside passed=true before publication; do not rewrite this raw.
        report["publicationEligible"] = False
        report["finished"] = stamp()
        try:
            json.dump(report, evidence, indent=2, ensure_ascii=False)
            evidence.write("\n")
            evidence.flush()
            os.fsync(evidence.fileno())
        finally:
            evidence.close()
    print(json.dumps({k: report[k] for k in ("passed", "nativePassed", "coverageComplete", "cleanupPassed", "publicationEligible", "pendingBrowserCoverage")}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
