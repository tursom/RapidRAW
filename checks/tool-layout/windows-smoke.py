"""Task 4 real Windows/Tauri smoke; parent builds, stages and executes this file.

Stage at E:/projects/tbt/rapidraw-tool-layout with the UNCHANGED baseline
windows-cdp.py and observe.js, keyboardUtils.ts, and fixture.json identifying the
isolated fixture/photo-000.NEF. Requires the baseline Windows Python environment
(websocket-client and pywin32). No Windows connection or credentials are used by
the authoring/static-check step. No export, generation, download or save dialog.

Run once per fresh directory. Existing evidence/windows-smoke.json or fixture
output is refused, never truncated. Normal errors after evidence reservation are
serialized with passed=false and a nonzero exit. Each group runs independently;
failed cases remain failed even if another group succeeds. coverageComplete also
requires every planned group/case and an empty pendingParentChecks list.

Only native profile seeds, the isolated persisted fixture metadata seed, and
library navigation are setup. Measured interactions
use CDP Input events, with explicit per-case trusted-event requirements. React
props are read from mounted components in the CURRENT root tree (DFS ancestry,
never alternate/return-chain guesses), scoped to real DOM hosts. They are never
mutated or called. The IPC fetch observer returns the original Promise/Response;
only cloned, allowlisted response bodies are read. Tauri internals are untouched.
Both profile files are restored byte-for-byte AFTER all owned processes stop.
Before mutation, their original bytes/existence manifest are durably backed up
under private ROOT/profile-backup. Keep that directory local and exclude it from
all publication/download archives, including when cleanup withholds restoration.
Exit 1 means error/failure; exit 2 means subsetPassed but pending full coverage.
Pending coverage is intentional and must be resolved by the parent, not treated
as a full Task 4 acceptance claim. Source interfaces may change during parent work.

Relight evidence scope (also for the parent's README): the persisted fixture has
relightEnabled=true and relightNormalMap=null. Restoration may supply an existing
cached map; its type, string length and SHA256 are recorded without raw map data.
Native relight::prepare returns None for a null/empty map; a real cached map is
allowed. These cases certify UI overlays, not lighting quality or map correctness.
"""

import copy
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import traceback


ROOT = Path(r"E:\projects\tbt\rapidraw-tool-layout")
BASE = Path(r"E:\projects\tbt\rapidraw-baseline")
EXE = BASE / "app/src-tauri/target/release/RapidRAW-tools.exe"
PHOTO = ROOT / "fixture/photo-000.NEF"
OUT = ROOT / "evidence"
OUTPUT = OUT / "windows-smoke.json"
TITLE = "RapidRAW TBT"
NASA_SHA256 = "5922721d13f11795557d97fdeb0a60b900086c402bc82a848ff280d15b99ffd4"
FROZEN = {"windows-cdp.py": "afbb755826f3691ce84296d52446507d25ad1877fde0cb00d8f8dd6f866ffc64",
          "observe.js": "487c7acf01b9cbbc4d00091d584e16755dfdeb08e644759edc0a1d2f2b3dc87b"}
DIALOG = '[role="dialog"][aria-modal="true"]'
CURVES = '[data-panel="curves"][data-panel-region="leftTop"]'
RIGHT = '[data-panel="adjustments"][data-panel-region="rightTop"]'
GROUPS = ("migration", "desktop-modes", "crop", "keyboard", "brush", "narrow",
          "viewport-scroll-divider", "collapsed", "centre-overlay", "relight-overlay", "compact", "no-image")
# These requirements are deliberately not certified by the automated subset.
PENDING = {
    "narrow-visual": "Parent inspect narrow-250-masks.png and narrow-250-ai.png for representative controls/text clipping. Automated rectangle checks do not certify label glyphs; every possible expanded control is outside this plan.",
}


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def seed_fixture_metadata(report):
    # ImageMetadata uses serde(default), version 1, rating 0 and adjustments
    # Value. read_sidecar reads raw JSON; parse_virtual_path appends .rrdata to
    # the complete image basename. This is a disposable persisted fixture, not
    # a live React/store write or a native read-only invoke replacement.
    path = PHOTO.with_name(PHOTO.name + ".rrdata")
    metadata = {"version": 1, "rating": 0, "adjustments": {"relightEnabled": True, "relightNormalMap": None}}
    row = {"kind": "persisted-fixture-metadata-seed", "path": str(path), "json": metadata,
           "reason": "Restore enabled Relight controls without invoking the normal-map-generating toggle; no lighting quality or normal-map validation is claimed."}
    report["setup"].append(row)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(metadata, stream, indent=2)
        stream.write("\n")
    row["sha256"] = sha(path)
    check(json.loads(path.read_text(encoding="utf-8")) == metadata, "Fixture metadata seed readback mismatch")
    report["fixtureMetadataSeed"] = copy.deepcopy(row)


def protect_backup_directory(path):
    import ntsecuritycon
    import win32api
    import win32security
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


def backup_profiles(original, report):
    path = ROOT / "profile-backup"
    path.mkdir(mode=0o700, exist_ok=False)
    row = report["profileBackup"] = {"path": str(path), "private": False, "verified": False,
                                     "publication": "PRIVATE LOCAL RECOVERY ONLY; exclude from public/download archives"}
    protect_backup_directory(path)
    row["private"] = True
    manifest = {"schema": "rapidraw-private-profile-backup-v1", "files": []}
    for source, data in original.items():
        entry = {"file": source.name, "existed": data is not None,
                 "sha256": hashlib.sha256(data).hexdigest() if data is not None else None}
        manifest["files"].append(entry)
        if data is not None:
            with (path / source.name).open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            check((path / source.name).read_bytes() == data, "Private backup readback mismatch: " + source.name)
    encoded = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    with (path / "manifest.json").open("xb") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    check((path / "manifest.json").read_bytes() == encoded, "Private backup manifest readback mismatch")
    row.update(verified=True, manifestSha256=sha(path / "manifest.json"), files=manifest["files"])


def validate_visual_review(review, request):
    check(isinstance(review, dict) and review.get("passed") is True, "Parent visual review did not pass")
    check(all(review.get(k) == request[k] for k in ("scriptSha256", "exeSha256")), "Visual review script/EXE hash mismatch")
    screenshots = review.get("screenshots")
    check(isinstance(screenshots, list) and len(screenshots) == len(request["screenshots"]), "Visual review screenshot count mismatch")
    check(all(isinstance(s, dict) and isinstance(s.get("path"), str) for s in screenshots), "Invalid visual review screenshot entries")
    actual = {s["path"]: s for s in screenshots}
    check(len(actual) == len(screenshots), "Duplicate visual review screenshot path")
    for expected in request["screenshots"]:
        entry = actual.get(expected["path"])
        check(entry is not None and all(entry.get(k) == expected[k] for k in ("path", "sha256", "bytes")), "Visual review screenshot identity mismatch")
        observations = entry.get("observations")
        check(isinstance(observations, (str, list, dict)) and
              (bool(observations.strip()) if isinstance(observations, str) else bool(observations)),
              "Visual review requires per-image observations")


def await_visual_review(report, timeout=300):
    screenshots = []
    for panel in ("masks", "ai"):
        case = next(c for c in report["cases"] if c["name"] == "narrow-controls-" + panel)
        check(case["passed"], "Cannot request review of failed narrow-panel case")
        path = OUT / ("narrow-250-" + panel + ".png")
        saved = case["details"]["screenshot"]
        check(not path.is_symlink() and saved["path"] == str(path) and sha(path) == saved["sha256"] and
              path.stat().st_size == saved["bytes"], "Screenshot changed before visual review request")
        screenshots.append({"path": path.name, "sha256": saved["sha256"], "bytes": saved["bytes"],
                            "capture": saved.get("capture", {"method": "unspecified"})})
    request = {"scriptSha256": report["scriptSha256"], "exeSha256": report["exeSha256"], "screenshots": screenshots}
    with (OUT / "visual-review-request.json").open("x", encoding="utf-8") as stream:
        json.dump(request, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    state = report["visualReview"] = {"request": request, "status": "waiting", "timeoutSeconds": timeout,
                                       "reviewer": "parent agent; not a human approval"}
    review_path = ROOT / "parent-visual-review.json"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if review_path.exists():
            try:
                check(not review_path.is_symlink() and review_path.stat().st_size <= 1024 * 1024, "Invalid parent review file")
                review_bytes = review_path.read_bytes()
                check(len(review_bytes) <= 1024 * 1024, "Parent review exceeds size limit")
                review = json.loads(review_bytes.decode("utf-8-sig"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                # Parent may still be finishing its file; no UI actions while waiting.
                time.sleep(0.25)
                continue
            report["parentVisualReview"] = review
            try:
                validate_visual_review(review, request)
                check(all(sha(OUT / s["path"]) == s["sha256"] and (OUT / s["path"]).stat().st_size == s["bytes"]
                          for s in screenshots), "Screenshot changed during visual review")
            except Exception:
                state.update(status="rejected", error=traceback.format_exc())
                return False
            with (OUT / "visual-review.json").open("x", encoding="utf-8") as stream:
                json.dump(review, stream, indent=2)
                stream.write("\n")
            report["pendingParentChecks"] = [p for p in report["pendingParentChecks"] if p["id"] != "narrow-visual"]
            state.update(status="verified", reviewSha256=hashlib.sha256(review_bytes).hexdigest())
            return True
        time.sleep(0.25)
    state["status"] = "timeout"
    return False


OBSERVER_JS = r"""(() => {
  if (window.toolsSmoke) throw Error('Already installed: use a fresh app');
  const s = window.toolsSmoke = {events:[],calls:[],errors:[],caseName:'setup',selectionChanges:[],armed:false};
  const internal=window.__TAURI_INTERNALS__, originalFetch=window.fetch;
  if(!internal?.invoke)throw Error('Real Tauri internals required');
  const before={invoke:internal.invoke,ipc:internal.ipc,postMessage:internal.postMessage};
  // Rebuild ancestry from the actual current tree. Bailout fibers may have stale
  // return links, so ancestry is carried by DFS rather than following .return.
  s.tree = () => {
    const host=[...document.querySelectorAll('#root *')].find(n=>Object.keys(n).some(k=>k.startsWith('__reactFiber$')));
    if(!host)throw Error('No React host');
    let f=host[Object.keys(host).find(k=>k.startsWith('__reactFiber$'))];
    while(f.return)f=f.return;
    const root=f.stateNode?.current;
    if(!root)throw Error('No mounted current root');
    const hosts=new Map(),components=[];
    const visit=(fiber,ancestors)=>{
      const chain=[fiber,...ancestors];
      if(fiber.stateNode instanceof Element && typeof fiber.type==='string')hosts.set(fiber.stateNode,chain);
      else if(fiber.memoizedProps)components.push({fiber,chain,p:fiber.memoizedProps});
      for(let child=fiber.child;child;child=child.sibling)visit(child,chain);
    };
    visit(root,[]);return {root,hosts,components};
  };
  s.props=(node,predicate)=>{
    const chain=s.tree().hosts.get(node);
    if(!chain)throw Error('Detached/stale React host');
    return chain.find(f=>typeof f.type!=='string'&&predicate(f.memoizedProps))?.memoizedProps??null;
  };
  s.hosts=f=>{
    const result=[];
    const visit=n=>{if(typeof n.type==='string'&&n.stateNode instanceof Element){result.push(n.stateNode);return;}
      for(let c=n.child;c;c=c.sibling)visit(c);};
    visit(f);return result;
  };
  s.components=(predicate,scope=document)=>s.tree().components.filter(c=>predicate(c.p)).map(c=>({
    ...c,nodes:s.hosts(c.fiber).filter(n=>n.isConnected&&scope.contains(n))
  })).filter(c=>c.nodes.length);
  s.component=(predicate,scope=document)=>{
    const all=s.components(predicate,scope);
    if(all.length!==1)throw Error('Expected one mounted scoped component, got '+all.length);
    return {p:all[0].p,node:all[0].nodes[0],nodes:all[0].nodes,fiber:all[0].fiber,chain:all[0].chain};
  };
  s.visible=node=>{
    if(!node?.isConnected)return false;
    const r=node.getBoundingClientRect();let l=Math.max(0,r.left),t=Math.max(0,r.top),rr=Math.min(innerWidth,r.right),b=Math.min(innerHeight,r.bottom);
    for(let p=node;p;p=p.parentElement){const c=getComputedStyle(p),q=p.getBoundingClientRect();
      if(c.display==='none'||c.visibility==='hidden'||Number(c.opacity)===0)return false;
      if(/auto|scroll|hidden|clip/.test(c.overflowX)){l=Math.max(l,q.left);rr=Math.min(rr,q.right);}
      if(/auto|scroll|hidden|clip/.test(c.overflowY)){t=Math.max(t,q.top);b=Math.min(b,q.bottom);}}
    return rr>l&&b>t;
  };
  s.one=(selector,scope=document,visible=true)=>{
    const nodes=[...scope.querySelectorAll(selector)].filter(n=>n.isConnected&&(!visible||s.visible(n)));
    if(nodes.length!==1)throw Error('Expected one '+selector+', got '+nodes.length);return nodes[0];
  };
  s.mark=(node,role)=>{if(!node)throw Error('Missing '+role);node.setAttribute('data-tools-smoke-role',role);return node;};
  const canvasPredicate=p=>p?.selectedImage&&typeof p.isCropping==='boolean'&&typeof p.isMasking==='boolean'&&
    typeof p.isAiEditing==='boolean'&&typeof p.handleCropComplete==='function'&&p.imageRenderSize;
  s.canvas=()=>{
    const c=s.component(canvasPredicate),root=c.p.overlayRoot;
    return {...c,overlayRoot:root instanceof Element&&root.isConnected?root:null};
  };
  s.canvasNodes=(selector,visible=true,canvas=s.canvas())=>{
    const tree=s.tree(),roots=[...new Set([...canvas.nodes,canvas.overlayRoot].filter(Boolean))];
    // A portal has React ancestry under ImageCanvas but a different physical
    // DOM parent. Konva's imperative children inherit their nearest React host's
    // ownership. Both the real props.overlayRoot and current fiber must agree.
    return [...new Set(roots.flatMap(root=>[...root.querySelectorAll(selector)]))].filter(node=>{
      let owned=false;
      for(let n=node;n instanceof Element;n=n.parentElement){
        const chain=tree.hosts.get(n);
        if(chain){owned=chain.includes(canvas.fiber);break;}
        if(roots.includes(n))break;
      }
      return owned&&node.isConnected&&(!visible||s.visible(node));
    });
  };
  s.canvasOne=selector=>{
    const all=s.canvasNodes(selector);
    if(all.length!==1)throw Error('Expected one canvas-owned portal target '+selector+', got '+all.length);
    return all[0];
  };
  s.mapDescription=value=>({type:typeof value,kind:value===null?'null':Array.isArray(value)?'array':typeof value,
    stringLength:typeof value==='string'?value.length:null,usableString:typeof value==='string'&&value.trim().length>0});
  s.graph=()=>{
    const root=s.one('[data-panel="curves"][data-panel-region="leftTop"]');
    const graph=s.one('svg[viewBox="0 0 255 255"]',root,false);
    const p=s.props(graph,p=>p?.adjustments?.curves&&typeof p.setAdjustments==='function');
    if(!p||p.isForMask)throw Error('Missing actual global curve props');return graph;
  };
  const mobilePredicate=p=>typeof p?.onPanelSelect==='function'&&Object.hasOwn(p,'activePanel');
  s.mobile=panel=>{
    const icons={adjustments:'sliders-horizontal',crop:'crop',masks:'layers',ai:'paintbrush',presets:'swatch-book',metadata:'info',export:'file-input'};
    const component=s.component(mobilePredicate);
    return s.one('button:has(svg.lucide-'+icons[panel]+')',component.node,false);
  };
  s.compactContentRoot=()=>{
    const root=s.component(mobilePredicate).node.previousElementSibling;
    if(!root?.isConnected)throw Error('Missing actual compact panel content');return root;
  };
  s.compactWaveform=()=>{
    const root=s.compactContentRoot(),button=s.one('button:has(svg.lucide-chart-area)',root,false);
    const all=s.components(p=>typeof p?.hasWaveform==='boolean'&&typeof p.hasHistogram==='boolean'&&
      typeof p.setDisplayMode==='function'&&typeof p.onToggleClipping==='function',root);
    return {buttonEnabled:!button.disabled,buttonVisible:s.visible(button),mounted:all.length,
      visible:all.filter(c=>c.nodes.some(s.visible)).length,
      rightAdjustmentsVisible:[...document.querySelectorAll('[data-panel=adjustments][data-panel-region=rightTop]')].some(s.visible)};
  };
  s.sectionAdjustments=section=>{
    // Editor intentionally omits tonal fields from ImageCanvas. Read the
    // owning, mounted AdjustmentSection instead; another section's memoized
    // full adjustments object can be stale for fields that it does not own.
    const regions=[...document.querySelectorAll('[data-panel=adjustments][data-panel-region=rightTop]')].filter(s.visible);
    if(regions.length>1)throw Error('Ambiguous right Adjustments region');
    let scope=regions[0],source='rightTop';
    if(!scope){
      const mobile=s.components(mobilePredicate).filter(c=>c.nodes.some(s.visible));
      if(mobile.length!==1||mobile[0].p.activePanel!=='adjustments')return null;
      scope=mobile[0].nodes[0].previousElementSibling;source='compactAdjustments';
    }
    if(!scope?.isConnected)return null;
    const all=s.components(p=>p?.sectionName===section&&p.adjustments&&typeof p.setAdjustments==='function',scope);
    if(!all.length)return null;
    if(all.length!==1)throw Error('Ambiguous current '+section+' AdjustmentSection');
    return {adjustments:all[0].p.adjustments,source};
  };
  s.side=side=>s.component(p=>p?.side===side&&p.topRegion===side+'Top'&&typeof p.renderPanel==='function');
  s.divider=()=>s.one('.cursor-row-resize',s.side('left').node,false);
  s.scrollers=region=>{
    const root=s.one('[data-panel-region="'+region+'"]',document,false);
    return [root,...root.querySelectorAll('*')].filter(n=>n.clientHeight>20&&n.scrollHeight>n.clientHeight+2&&
      /auto|scroll/.test(getComputedStyle(n).overflowY)&&s.visible(n));
  };
  s.scrollTarget=region=>{
    const all=s.scrollers(region);
    if(!all.length){
      const side=s.side('left').node;
      for(let n=s.one('[data-panel-region="'+region+'"]',document,false).parentElement;n&&side.contains(n);n=n.parentElement)
        if(n.clientHeight>20&&n.scrollHeight>n.clientHeight+2&&/auto|scroll/.test(getComputedStyle(n).overflowY)&&s.visible(n))all.push(n);
    }
    if(!all.length)throw Error('No overflowing content or left-column scroller for '+region);
    return all.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0];
  };
  s.controls=panel=>{
    const root=s.one('[data-panel="'+panel+'"]');
    const bounds=root.getBoundingClientRect();
    return [...root.querySelectorAll('button,input,textarea,[role="button"]')].filter(n=>n.getBoundingClientRect().width>0).map(n=>{
      const r=n.getBoundingClientRect();return {tag:n.tagName,text:(n.innerText||n.getAttribute('placeholder')||n.getAttribute('aria-label')||'').slice(0,100),
        disabled:!!n.disabled,visible:s.visible(n),rect:r.toJSON(),
        horizontalFit:r.left>=bounds.left-1&&r.right<=bounds.right+1,
        noInternalOverflow:n.scrollWidth<=n.clientWidth+1};});
  };
  const titles={curves:'Curves',folderTree:'Sources',tethering:'Tethering',crop:'Crop & Transform',
    masks:'Masking',ai:'Inpainting',presets:'Presets',adjustments:'Adjustments',metadata:'Metadata',export:'Export'};
  s.contentEvidence=(root,panel)=>{
    if(!root?.isConnected)return {matched:false};
    const headings=[...root.querySelectorAll('p,span,h1,h2,h3')].filter(n=>n.textContent.trim()===titles[panel]);
    return {matched:headings.some(s.visible),title:titles[panel],mounted:headings.length,
      visible:headings.filter(s.visible).length,text:root.innerText.slice(0,1400)};
  };
  s.describe=node=>({tag:node?.tagName,label:node?.getAttribute('aria-label'),text:node?.textContent?.trim().slice(0,100),
    panel:node?.closest('[data-panel]')?.dataset.panel,tab:node?.closest('[data-tab-id]')?.dataset.tabId});
  for(const type of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','click','keydown','keyup','input','beforeinput','wheel']){
    window.addEventListener(type,e=>{if(type.endsWith('move')&&!e.buttons)return;
      const n=e.target instanceof Element?e.target:null;
      s.events.push({type,trusted:e.isTrusted,caseName:s.caseName,role:n?.closest('[data-tools-smoke-role]')?.getAttribute('data-tools-smoke-role')??null,
        target:s.describe(n),code:e.code??null,key:e.key??null,x:e.clientX??null,y:e.clientY??null,buttons:e.buttons??null,
        deltaY:e.deltaY??null,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,at:performance.now()});},true);
  }
  const watched=new Set(['is_tethering_supported','estimate_export_sizes','load_metadata']);
  const hook={verified:false,errors:[],promiseIdentity:false,responseIdentity:false};
  const observeError=(row,error)=>{hook.errors.push(String(error));if(row)row.observationError=String(error);};
  function observedFetch(...args){
    let row=null;
    try{
      const input=args[0],url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href);
      if(url.hostname==='ipc.localhost'){
        const command=decodeURIComponent(url.pathname.slice(1));
        row={command,caseName:s.caseName,at:performance.now(),status:'pending'};s.calls.push(row);
        // Never record request headers, invoke keys, settings or credentials.
        if(watched.has(command)){
          const parse=text=>{try{row.args=JSON.parse(text);}catch(e){observeError(row,e);}};
          if(typeof args[1]?.body==='string')parse(args[1].body);
          else if(input instanceof Request)input.clone().text().then(parse,e=>observeError(row,e));
          else observeError(row,'Unsupported watched request body');
        }
      }
    }catch(e){observeError(row,e);}
    let promise;
    try{promise=Reflect.apply(originalFetch,this,args);}catch(e){if(row){row.status='error';row.error=String(e);}throw e;}
    // Attach observers, but DO NOT return .then(), an async Promise or a clone.
    if(row)promise.then(response=>{
      row.httpStatus=response.status;row.nativeOk=response.headers.get('Tauri-Response')==='ok';
      row.status=row.nativeOk?'fulfilled':'error';
      if(watched.has(row.command))try{
        const clone=response.clone(),type=(clone.headers.get('content-type')||'').split(';')[0].split(',')[0];
        if(!['application/json','text/plain'].includes(type))throw Error('Unexpected observed response type '+type);
        (type==='application/json'?clone.json():clone.text()).then(value=>{
          if(row.nativeOk)row.result=value;else row.error=value;
        },e=>observeError(row,e));
      }catch(e){observeError(row,e);}
    },e=>{row.status='error';row.error=String(e);});
    if(s.identityProbe){s.identityProbe.originalPromise=promise;
      promise.then(response=>{s.identityProbe.originalResponse=response;},()=>{});}
    return promise;
  }
  window.fetch=observedFetch;
  s.hookStatus=()=>({installed:window.fetch===observedFetch,verified:hook.verified,errors:hook.errors,
    promiseIdentity:hook.promiseIdentity,responseIdentity:hook.responseIdentity,
    internalsUnchanged:window.__TAURI_INTERNALS__===internal&&Object.entries(before).every(([k,v])=>internal[k]===v)});
  s.assertHook=()=>{const h=s.hookStatus();if(!h.installed||!h.verified||!h.internalsUnchanged||h.errors.length||!h.promiseIdentity||!h.responseIdentity)
    throw Error('IPC observer integrity failure '+JSON.stringify(h));};
  s.probe=async()=>{
    // A harmless data: fetch verifies wrapper Promise/Response identity; the
    // ordinary native invoke below independently verifies actual IPC transport.
    // No fabricated Response, patched invoke or captured authentication header.
    s.identityProbe={};
    const returned=window.fetch('data:text/plain,tools-smoke-identity');
    hook.promiseIdentity=returned===s.identityProbe.originalPromise;
    const response=await returned;
    hook.responseIdentity=response===s.identityProbe.originalResponse;
    delete s.identityProbe;
    const value=await internal.invoke('is_tethering_supported');
    const deadline=performance.now()+3000;let row;
    do{row=s.calls.find(c=>c.command==='is_tethering_supported'&&c.status==='fulfilled'&&c.result===value&&c.args);
      if(row)break;await new Promise(r=>setTimeout(r,20));}while(performance.now()<deadline);
    if(!row||typeof value!=='boolean')throw Error('Real IPC probe did not traverse fetch observer');
    hook.verified=true;s.assertHook();return {hook:s.hookStatus(),tethering:value};
  };
  s.snapshot=()=>{
    s.assertHook();const canvas=s.canvas(),p=canvas.p;
    if(!s.visible(canvas.node))throw Error('Actual ImageCanvas host is not visible');
    const view=s.component(p=>['full','wide','compact'].includes(p?.layoutMode)&&typeof p.renderAppPanel==='function');
    const mobile=s.components(mobilePredicate).filter(c=>c.nodes.some(s.visible));
    if(mobile.length>1)throw Error('Ambiguous visible mobile switcher');
    const panels=[...document.querySelectorAll('[data-panel-region][data-panel]')].filter(s.visible).map(n=>({panel:n.dataset.panel,region:n.dataset.panelRegion,
      rect:n.getBoundingClientRect().toJSON(),content:s.contentEvidence(n,n.dataset.panel)}));
    const tabs=[...document.querySelectorAll('[data-tab-id]')].filter(s.visible).map(n=>{
      const q=s.props(n,p=>typeof p?.panel==='string'&&typeof p.region==='string'&&['left','right'].includes(p.side));
      if(!q||n.dataset.tabId!=='layout-tab-'+q.panel)throw Error('Tab DOM/current props mismatch');
      return {panel:q.panel,region:q.region,disabled:!!n.disabled,rect:n.getBoundingClientRect().toJSON()};});
    const sidebars=['left','right'].map(side=>{
      const all=s.components(p=>p?.side===side&&p.topRegion===side+'Top'&&typeof p.renderPanel==='function');
      if(!all.length)return {side,visible:false};if(all.length!==1)throw Error('Ambiguous sidebar');
      const n=all[0].nodes[0];return {side,visible:s.visible(n),width:n.getBoundingClientRect().width,propWidth:all[0].p.width};});
    const adj=p.adjustments,basic=s.sectionAdjustments('basic'),effects=s.sectionAdjustments('effects');
    const globals=[...document.querySelectorAll('[data-panel=curves][data-panel-region=leftTop] svg[viewBox="0 0 255 255"]')];
    if(globals.length>1)throw Error('Ambiguous mounted global curve');
    const curve=globals.length?s.props(globals[0],q=>q?.adjustments?.curves&&typeof q.setAdjustments==='function'&&!q.isForMask)?.adjustments:null;
    const geometry=Object.fromEntries(['crop','rotation','orientationSteps','flipHorizontal','flipVertical','aspectRatio'].map(k=>[k,adj[k]??null]));
    const curveGraphs=[...document.querySelectorAll('svg[viewBox="0 0 255 255"]')].map(n=>{
      const q=s.props(n,p=>p?.adjustments?.curves&&typeof p.setAdjustments==='function');
      return {mask:!!q?.isForMask,visible:s.visible(n),region:n.closest('[data-panel-region]')?.dataset.panelRegion??'compact'};});
    return {path:p.selectedImage.path,ready:p.selectedImage.isReady,mode:{crop:p.isCropping,masks:p.isMasking,ai:p.isAiEditing},
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},layoutMode:view.p.layoutMode,
      panels,tabs,sidebars,compactActivePanel:mobile[0]?.p.activePanel??null,
      compactContent:mobile.length?s.contentEvidence(mobile[0].nodes[0].previousElementSibling,mobile[0].p.activePanel):null,geometry,draftCrop:p.crop,
      curves:curve?.curves??null,curveMode:curve?.curveMode??null,exposure:basic?.adjustments.exposure??null,masks:adj.masks??[],aiPatches:adj.aiPatches??[],
      adjustmentSources:{basic:basic?.source??null,effects:effects?.source??null,curves:curve?'leftTopCurveGraph':null},
      relight:{observable:!!effects,enabled:effects?.adjustments.relightEnabled===true,
        normalMap:s.mapDescription(effects?.adjustments.relightNormalMap),
        normalMapPresent:s.mapDescription(effects?.adjustments.relightNormalMap).usableString,lights:effects?.adjustments.relightLights??[]},
      activeMaskId:p.activeMaskId,activeMaskContainerId:p.activeMaskContainerId,curveGraphs,
      imageCanvas:{rect:canvas.node.getBoundingClientRect().toJSON(),renderSize:p.imageRenderSize,rendered:p.hasRenderedFirstFrame,
        overlayRoot:canvas.overlayRoot?{source:'current ImageCanvas.props.overlayRoot',rect:canvas.overlayRoot.getBoundingClientRect().toJSON()}:null,
        cropSelection:s.canvasNodes('.ReactCrop__crop-selection',true,canvas).map(n=>n.getBoundingClientRect().toJSON()),
        konva:s.canvasNodes('.konvajs-content canvas',true,canvas).map(n=>n.getBoundingClientRect().toJSON())},
      rightText:document.querySelector('[data-panel="adjustments"][data-panel-region="rightTop"]')?.innerText??'',
      rightSections:s.components(q=>typeof q?.title==='string'&&typeof q.onToggle==='function'&&typeof q.isOpen==='boolean',
        document.querySelector('[data-panel="adjustments"][data-panel-region="rightTop"]')??document.createElement('div')).map(c=>c.p.title),
      dialogs:[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(s.visible).map(n=>({label:n.getAttribute('aria-label'),text:n.innerText.slice(0,1600),rect:n.getBoundingClientRect().toJSON()})),
      selectionChanges:s.selectionChanges};
  };
  s.emptySnapshot=()=>{
    s.assertHook();
    const panels=[...document.querySelectorAll('[data-panel-region][data-panel]')].filter(s.visible).map(n=>({
      panel:n.dataset.panel,region:n.dataset.panelRegion,text:n.innerText.slice(0,1200)}));
    return {canvasCount:s.components(canvasPredicate).length,
      editorViewCount:s.components(p=>['full','wide','compact'].includes(p?.layoutMode)&&typeof p.renderAppPanel==='function').length,
      panels,tabs:[...document.querySelectorAll('[data-tab-id]')].filter(s.visible).map(n=>({
        panel:n.dataset.tabId.replace('layout-tab-',''),disabled:!!n.disabled})),
      disabledHeader:['Info','Export'].map(label=>{const n=document.querySelector('[data-panel=curves] button[aria-label="'+label+'"]');
        return {label,mounted:!!n,disabled:!!n?.disabled};}),
      viewport:{width:innerWidth,height:innerHeight},selectionChanges:s.selectionChanges};
  };
  s.overlayEvidence=()=>{
    const canvas=s.canvas();
    // StageWrap's current React ancestry owns it through ImageCanvas's portal.
    // Inspect its rendered children and the real Konva framebuffer together;
    // React element presence alone is not evidence of drawn canvas content.
    return s.components(p=>Object.hasOwn(p??{},'forwardedRef')&&typeof p.width==='number'&&
      typeof p.height==='number'&&typeof p.onMouseDown==='function',canvas.overlayRoot??canvas.node)
      .filter(c=>c.chain.includes(canvas.fiber)).map(c=>{
      let centres=0,lights=0;
      const visit=e=>{if(Array.isArray(e)){e.forEach(visit);return;}if(!e?.props)return;
        const p=e.props;
        if(p.pos&&typeof p.midpoint==='number'&&typeof p.roundness==='number'&&typeof p.onReset==='function')centres++;
        if(p.light?.id&&p.basis&&typeof p.onAim==='function')lights++;
        visit(p.children);};
      visit(c.p.children);
      const n=c.nodes[0],frames=[...n.querySelectorAll('.konvajs-content canvas')].filter(s.visible).map(frame=>{
        const ctx=frame.getContext('2d');if(!ctx)throw Error('Expected real Konva 2D canvas');
        const pixels=ctx.getImageData(0,0,frame.width,frame.height).data;
        let nontransparent=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])nontransparent++;
        return {width:frame.width,height:frame.height,nontransparent,rect:frame.getBoundingClientRect().toJSON()};});
      return {centres,lights,visible:s.visible(n),frames};
    });
  };
  const tick=()=>{if(s.armed)try{const path=s.canvas().p.selectedImage.path;
    if(path!==s.expectedPath)s.selectionChanges.push({path,at:performance.now()});
  }catch(e){s.errors.push(String(e));}requestAnimationFrame(tick);};requestAnimationFrame(tick);
})()"""


def req(kind, role=None, code=None):
    return {"type": kind, **({"role": role} if role else {}), **({"code": code} if code else {})}


def mode(panel):
    return {"crop": panel == "crop", "masks": panel == "masks", "ai": panel == "ai"}


def active(state, panel, compact=False):
    if state["mode"] != mode(panel):
        return False
    if compact:
        return (state["layoutMode"] == "compact" and state["compactActivePanel"] == panel and
                bool(state["compactContent"] and state["compactContent"]["matched"]))
    region = "leftTop" if panel in ("curves", "folderTree", "tethering") else "leftBottom"
    if panel == "adjustments":
        return any(p["region"] == "rightTop" and p["panel"] == panel and p["content"]["matched"] for p in state["panels"])
    return any(p["region"] == region and p["panel"] == panel and p["content"]["matched"] for p in state["panels"])


def fixed(state, tethering):
    expected_top = ["curves", "folderTree"] + (["tethering"] if tethering else [])
    return (state["layoutMode"] == "full" and
            [t["panel"] for t in state["tabs"] if t["region"] == "leftTop"] == expected_top and
            [t["panel"] for t in state["tabs"] if t["region"] == "leftBottom"] == ["crop", "masks", "ai", "presets"] and
            not any(t["region"].startswith("right") for t in state["tabs"]) and
            sum(p["panel"] == "adjustments" for p in state["panels"]) == 1 and
            any(p["panel"] == "adjustments" and p["region"] == "rightTop" and p["content"]["matched"] for p in state["panels"]) and
            all(title in state["rightSections"] for title in ("Basic", "Color", "Details", "Effects")) and
            not any(p["region"] == "rightBottom" for p in state["panels"]))


def keyboard_defaults():
    source = next((p for p in (ROOT / "keyboardUtils.ts", BASE / "app/src/utils/keyboardUtils.ts") if p.is_file()), None)
    check(source is not None, "Stage keyboardUtils.ts at ROOT or BASE/app/src/utils")
    text = source.read_text(encoding="utf-8-sig")
    combos = {}
    for action in ("toggle_adjustments", "toggle_crop_panel", "toggle_masks", "toggle_ai", "toggle_presets",
                   "toggle_metadata", "toggle_export", "toggle_left_panel"):
        match = re.search(r"action:\s*'" + action + r"'\s*,[\s\S]*?defaultCombo:\s*\[([^]]*)\]", text)
        check(match is not None, "Cannot read keybind " + action)
        combos[action] = re.findall(r"'([^']+)'", match.group(1))
        check(len([p for p in combos[action] if p not in ("ctrl", "shift", "alt")]) == 1,
              "Unsupported keybind " + action)
    return {"path": str(source), "sha256": sha(source), "combos": combos}


class Smoke:
    def __init__(self, driver, process, cdp, hwnd, report):
        self.driver, self.process, self.cdp, self.hwnd, self.report = driver, process, cdp, hwnd, report
        self.group = "setup"
        self.details = {}
        self.mask_baseline = None
        self.empty = False

    def js(self, expression):
        return self.cdp.js(expression)

    def frame(self):
        self.js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

    def snapshot(self):
        return self.js("toolsSmoke.emptySnapshot()" if self.empty else "toolsSmoke.snapshot()")

    def point(self, expression, role, fx=0.5, fy=0.5):
        self.js("toolsSmoke.mark((" + expression + ")," + json.dumps(role) +
                ").scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})")
        self.frame()
        return self.js("""(() => {const e=(""" + expression + """),r=e.getBoundingClientRect();
          if(e.disabled||e.getAttribute('aria-disabled')==='true')throw Error('Disabled target');
          const x=r.left+r.width*""" + str(fx) + ",y=r.top+r.height*" + str(fy) + """;
          if(!toolsSmoke.visible(e)||!e.contains(document.elementFromPoint(x,y)))throw Error('Target occluded');
          return {x,y};})()""")

    def mouse(self, kind, point, buttons=None):
        self.cdp.call("Input.dispatchMouseEvent", {"type": kind, **point, "button": "left",
                      "buttons": (0 if kind == "mouseReleased" else 1) if buttons is None else buttons,
                      "clickCount": 0 if kind == "mouseMoved" else 1})

    def click_expr(self, expression, role, fx=0.5, fy=0.5):
        point = self.point(expression, role, fx, fy)
        self.mouse("mouseMoved", point, 0)
        self.mouse("mousePressed", point)
        self.mouse("mouseReleased", point)
        self.frame()

    def click(self, selector, role, fx=0.5, fy=0.5):
        self.click_expr("toolsSmoke.one(" + json.dumps(selector) + ",document,false)", role, fx, fy)

    def tab(self, panel):
        self.click('[data-tab-id="layout-tab-' + panel + '"]', "tab-" + panel)
        # data-panel updates before AnimatePresence finishes replacing content.
        self.driver.wait_js(self.cdp, "toolsSmoke.snapshot().panels.some(p=>p.panel===" + json.dumps(panel) + "&&p.content.matched)")

    def key(self, code, modifiers=0):
        special = {"Escape": ("Escape", 27), "Enter": ("Enter", 13), "Tab": ("Tab", 9)}
        key, vk = special.get(code, (code[3:].lower(), ord(code[-1]) if code.startswith("Key") else 0))
        check(vk != 0, "Unsupported key " + code)
        for kind in ("keyDown", "keyUp"):
            self.cdp.call("Input.dispatchKeyEvent", {"type": kind, "key": key, "code": code,
                          "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": modifiers})
        self.frame()

    def shortcut(self, action):
        parts = self.report["keyboardDefaults"]["combos"][action]
        code = next(p for p in parts if p not in ("ctrl", "shift", "alt"))
        self.key(code, sum({"ctrl": 2, "shift": 8, "alt": 1}[p] for p in parts if p in ("ctrl", "shift", "alt")))

    def keyreq(self, action):
        code = next(p for p in self.report["keyboardDefaults"]["combos"][action] if p not in ("ctrl", "shift", "alt"))
        return [req("keydown", code=code), req("keyup", code=code)]

    def drag(self, expression, role, dx, dy, fx=0.5, fy=0.5):
        start = self.point(expression, role, fx, fy)
        self.mouse("mouseMoved", start, 0)
        self.mouse("mousePressed", start)
        for step in range(1, 9):
            self.mouse("mouseMoved", {"x": start["x"] + dx * step / 8, "y": start["y"] + dy * step / 8})
            self.frame()
        self.mouse("mouseReleased", {"x": start["x"] + dx, "y": start["y"] + dy})
        self.frame()

    def record(self, name, action, predicate, expected, timeout=12):
        check(bool(expected), "Explicit trusted input requirements are mandatory")
        check(name not in [r["name"] for r in self.report["cases"]], "Duplicate case " + name)
        self.details = {}
        row = {"name": name, "group": self.group, "passed": False, "expectedTrusted": expected}
        self.report["cases"].append(row)
        self.js("document.querySelectorAll('[data-tools-smoke-role]').forEach(n=>n.removeAttribute('data-tools-smoke-role'));" +
                "toolsSmoke.events.length=0;toolsSmoke.caseName=" + json.dumps(name))
        start = self.js("toolsSmoke.calls.length")
        try:
            action()
            deadline = time.monotonic() + timeout
            while True:
                self.frame()
                state = self.snapshot()
                if self.empty:
                    check(state["canvasCount"] == 0 and state["editorViewCount"] == 0, "An image/editor mounted during no-selection phase")
                else:
                    check(state["path"] == str(PHOTO) and state["ready"], "Not the ready isolated RAW")
                check(not state["selectionChanges"], "Transient fixture selection change")
                if self.mask_baseline is not None:
                    check(state["masks"] == self.mask_baseline, "Unrelated action changed mask data")
                if predicate(state):
                    break
                check(time.monotonic() < deadline, "Result predicate timed out: " + name)
                time.sleep(0.05)
            events = self.js("toolsSmoke.events")
            row.update(state=state, events=events, details=self.details, calls=self.js("toolsSmoke.calls.slice(" + str(start) + ")"))
            for requirement in expected:
                check(any(e["trusted"] and e["caseName"] == name and all(e.get(k) == v for k, v in requirement.items())
                          for e in events), "Missing trusted input: " + repr(requirement))
            check(all(e["trusted"] for e in events), "Synthetic events during measured case")
            check(not self.js("toolsSmoke.errors.length"), "Observer selection sampling failed")
            row["passed"] = True
            return state
        except Exception:
            row["error"] = traceback.format_exc()
            row["details"] = self.details
            try:
                row.update(state=self.snapshot(), events=self.js("toolsSmoke.events"),
                           calls=self.js("toolsSmoke.calls.slice(" + str(start) + ")"))
            except Exception:
                row["observationError"] = traceback.format_exc()
            raise

    def resize(self, width, height):
        # Real HWND resize, no emulated viewport or fake device metrics.
        samples = []
        win32gui.ShowWindow(self.hwnd, win32con.SW_RESTORE)
        for _ in range(8):
            before = self.js("({width:innerWidth,height:innerHeight})")
            outer, client = win32gui.GetWindowRect(self.hwnd), win32gui.GetClientRect(self.hwnd)
            samples.append({"viewport": before, "outer": outer, "client": client})
            if (before["width"], before["height"]) == (width, height):
                break
            sx, sy = (client[2] - client[0]) / before["width"], (client[3] - client[1]) / before["height"]
            win32gui.SetWindowPos(self.hwnd, None, 40, 40,
                                 outer[2] - outer[0] + round((width - before["width"]) * sx),
                                 outer[3] - outer[1] + round((height - before["height"]) * sy),
                                 win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)
            time.sleep(0.25)
            self.frame()
        after = self.js("({width:innerWidth,height:innerHeight})")
        self.details["nativeResize"] = {"requested": [width, height], "samples": samples, "after": after}
        check((after["width"], after["height"]) == (width, height), "Native resize failed")
        time.sleep(0.4)

    def reset_group(self):
        # Recovery is outside measured cases and recorded. No React callback,
        # setter, injected mode flag or native edit is used to repair a group.
        self.js("toolsSmoke.caseName='group-recovery'")
        for _ in range(3):
            if not self.js("[...document.querySelectorAll(" + json.dumps(DIALOG) + ")].some(toolsSmoke.visible)"):
                break
            self.key("Escape")
        self.resize(1280, 720)
        if not self.js("[...document.querySelectorAll('[data-tab-id=layout-tab-presets]')].some(toolsSmoke.visible)"):
            self.shortcut("toggle_left_panel")
        self.tab("presets")
        self.tab("curves")
        self.driver.wait_js(self.cdp, "toolsSmoke.snapshot().mode.crop===false&&toolsSmoke.snapshot().mode.masks===false&&toolsSmoke.snapshot().mode.ai===false")
        self.report["setup"].append({"kind": "trusted-group-recovery", "group": self.group, "state": self.snapshot()})

    def modal(self, label):
        return lambda r: len(r["dialogs"]) == 1 and r["dialogs"][0]["label"] == label

    def close_modal(self):
        self.click(DIALOG + ' > button[aria-label="Close"]', "modal-close")

    def relight_map_diagnostics(self):
        observed = self.js("""(() => {const section=toolsSmoke.sectionAdjustments('effects');
          if(!section)throw Error('Current Effects section unavailable for map diagnostics');
          const value=section.adjustments.relightNormalMap;
          return {...toolsSmoke.mapDescription(value),rawString:typeof value==='string'?value:null};})()""")
        raw = observed.pop("rawString")
        if isinstance(raw, str):
            observed["stringUtf8Bytes"] = len(raw.encode("utf-8"))
            observed["stringSha256"] = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        return observed

    def screenshot(self, name):
        path = OUT / (name + ".png")
        try:
            data, capture = self.desktop_client_png()
        except Exception:
            capture = {"method": "CDP/Page.captureScreenshot-fallback", "error": traceback.format_exc(),
                       "pixelScope": "WebView only; native WGPU/DComp image composition is not certified"}
            self.report["limits"].append("Desktop client capture unavailable for " + name +
                                         "; canonical PNG is explicitly WebView-only and cannot prove native GPU image pixels.")
            data = base64.b64decode(self.cdp.call("Page.captureScreenshot", {"format": "png"})["data"], validate=True)
        with path.open("xb") as stream:
            stream.write(data)
        self.details["screenshot"] = {"path": str(path), "sha256": sha(path), "bytes": len(data), "capture": capture}

    def desktop_client_png(self):
        import ctypes
        import io
        import win32api
        from PIL import ImageGrab
        check(self.process.poll() is None and win32process.GetWindowThreadProcessId(self.hwnd)[1] == self.process.pid,
              "Desktop capture requires the live owned HWND")
        if win32gui.GetForegroundWindow() != self.hwnd:
            win32gui.SetForegroundWindow(self.hwnd)
        deadline = time.monotonic() + 3
        while win32gui.GetForegroundWindow() != self.hwnd and time.monotonic() < deadline:
            time.sleep(0.05)
        check(win32gui.GetForegroundWindow() == self.hwnd, "Owned HWND is not foreground for capture")
        viewport = self.js("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})")
        check((viewport["width"], viewport["height"]) == (1280, 720), "Review capture requires actual 1280x720 viewport")
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        user32.GetDpiForWindow.argtypes, user32.GetDpiForWindow.restype = [ctypes.c_void_p], ctypes.c_uint
        previous = user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        check(previous is not None, "Cannot establish per-monitor physical capture coordinates")
        try:
            client = win32gui.GetClientRect(self.hwnd)
            size = (client[2] - client[0], client[3] - client[1])
            check(size == (1280, 720), "Review capture requires physical 1280x720 client, got " + repr(size))
            origin = win32gui.ClientToScreen(self.hwnd, (0, 0))
            bbox = (origin[0], origin[1], origin[0] + size[0], origin[1] + size[1])
            screen = (win32api.GetSystemMetrics(76), win32api.GetSystemMetrics(77),
                      win32api.GetSystemMetrics(78), win32api.GetSystemMetrics(79))
            check(bbox[0] >= screen[0] and bbox[1] >= screen[1] and
                  bbox[2] <= screen[0] + screen[2] and bbox[3] <= screen[1] + screen[3],
                  "Owned client is clipped outside the virtual screen")
            image = ImageGrab.grab(bbox=bbox, all_screens=True)
            check(image.size == size and win32gui.GetForegroundWindow() == self.hwnd,
                  "Client capture dimensions/foreground ownership changed")
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            return buffer.getvalue(), {"method": "PIL.ImageGrab/owned-Windows-client", "bbox": bbox,
                "clientPixels": size, "viewport": viewport, "dpi": user32.GetDpiForWindow(self.hwnd),
                "coordinateMode": "PER_MONITOR_AWARE_V2", "foregroundOwned": True, "clipped": False,
                "virtualScreen": screen, "pixelScope": "Visible owned client including native composition; no RAW-pixel or lighting-quality comparison"}
        finally:
            check(user32.SetThreadDpiAwarenessContext(previous) is not None, "Cannot restore capture thread DPI context")


def group_migration(s):
    initial = s.snapshot()
    s.report["migrationInitialState"] = initial
    check(fixed(initial, s.report["tetheringSupported"]), "Hostile saved layout was not replaced by fixed desktop layout")
    check(active(initial, "presets") and any(p["panel"] == "curves" for p in initial["panels"]), "Desktop must default to Curves + Presets")
    for side in ("left", "right"):
        check(any(p["side"] == side and abs(p["width"] - 350) < 1 and p["propWidth"] == 350 for p in initial["sidebars"]),
              "Saved width not retained in DOM/current props: " + side)
    for panel in ["folderTree"] + (["tethering"] if s.report["tetheringSupported"] else []) + ["curves"]:
        s.record("top-tab-" + panel, lambda panel=panel: s.tab(panel),
                 lambda r, panel=panel: active(r, panel) and fixed(r, s.report["tetheringSupported"]), [req("click", "tab-" + panel)])
    # Native persisted dimensions are read separately from rendered geometry.
    effective = s.js("window.__TAURI_INTERNALS__.invoke('load_settings')")
    s.report["nativeWorkspaceAfterMigration"] = effective["workspace"]
    for name, value in s.report["seedWorkspace"].items():
        if name.endswith("Width") or name.endswith("Height"):
            check(effective["workspace"][name] == value, "Migration overwrote saved dimension " + name)


def group_modes(s):
    for index, panel in enumerate(("crop", "masks", "ai", "presets")):
        s.record("desktop-enter-" + panel, lambda panel=panel: s.tab(panel),
                 lambda r, panel=panel: active(r, panel) and fixed(r, s.report["tetheringSupported"]), [req("click", "tab-" + panel)])
        before = s.snapshot()
        check(isinstance(before["exposure"], (int, float)), "Current right Basic section exposure is unavailable")
        selector = RIGHT + ' [data-speed-edit-id="exposure"] input[type="range"]'
        s.record("right-exposure-retains-" + panel,
                 lambda index=index: s.click(selector, "right-exposure", fx=0.56 + index * 0.045),
                 lambda r, panel=panel, before=before: active(r, panel) and isinstance(r["exposure"], (int, float)) and r["exposure"] != before["exposure"] and
                 fixed(r, s.report["tetheringSupported"]),
                 [req("pointerdown", "right-exposure"), req("pointerup", "right-exposure")])
        before = copy.deepcopy(s.snapshot()["curves"])
        check(isinstance(before, dict) and len(before) == 4, "Current global curve adjustments are unavailable")
        s.record("left-curve-retains-" + panel,
                 lambda index=index: s.click_expr("toolsSmoke.graph()", "global-curve", 0.22 + index * 0.16, 0.32),
                 lambda r, panel=panel, before=before: active(r, panel) and isinstance(r["curves"], dict) and r["curves"] != before and
                 len([g for g in r["curveGraphs"] if not g["mask"] and g["visible"] and g["region"] == "leftTop"]) == 1 and
                 not any(not g["mask"] and g["region"].startswith("right") for g in r["curveGraphs"]),
                 [req("mousedown", "global-curve"), req("mouseup", "global-curve")])


def group_crop(s):
    # Drag an ACTUAL react-image-crop handle. Check geometry before exiting; an
    # Enter event alone or a mode flag alone cannot certify Apply/Cancel.
    s.record("crop-enter-apply-session", lambda: s.tab("crop"), lambda r: active(r, "crop") and bool(r["imageCanvas"]["cropSelection"]),
             [req("click", "tab-crop")], timeout=60)
    before = copy.deepcopy(s.snapshot()["geometry"])
    handle = "toolsSmoke.canvasOne('.ReactCrop__drag-handle.ord-se')"
    s.record("crop-real-handle-change", lambda: s.drag(handle, "crop-handle", -35, -24),
             lambda r: active(r, "crop") and r["geometry"] != before and bool(r["imageCanvas"]["cropSelection"]),
             [req("pointerdown", "crop-handle"), req("pointermove"), req("pointerup")])
    applied = copy.deepcopy(s.snapshot()["geometry"])
    s.record("crop-enter-applies", lambda: s.key("Enter"), lambda r: active(r, "presets") and r["geometry"] == applied,
             [req("keydown", code="Enter"), req("keyup", code="Enter")])
    cancel_entry_geometry = copy.deepcopy(s.snapshot()["geometry"])
    s.report["cropCancelGeometryBeforeEntry"] = copy.deepcopy(cancel_entry_geometry)
    s.record("crop-enter-cancel-session", lambda: s.tab("crop"), lambda r: active(r, "crop") and bool(r["imageCanvas"]["cropSelection"]),
             [req("click", "tab-crop")], timeout=60)
    baseline = copy.deepcopy(s.snapshot()["geometry"])
    s.report["cropCancelGeometryAfterEntryProjection"] = copy.deepcopy(baseline)
    s.record("crop-second-real-change", lambda: s.drag(handle, "crop-handle", -28, -18),
             lambda r: active(r, "crop") and r["geometry"] != baseline,
             [req("pointerdown", "crop-handle"), req("pointermove"), req("pointerup")])
    s.record("crop-escape-restores-session", lambda: s.key("Escape"),
             lambda r: active(r, "presets") and r["geometry"] == cancel_entry_geometry,
             [req("keydown", code="Escape"), req("keyup", code="Escape")])
    for panel in ("crop", "masks", "ai"):
        s.record("presets-from-" + panel, lambda panel=panel: (s.tab(panel), s.tab("presets")),
                 lambda r: active(r, "presets"), [req("click", "tab-" + panel), req("click", "tab-presets")])


def group_keyboard(s):
    for action, panel in (("toggle_crop_panel", "crop"), ("toggle_masks", "masks"), ("toggle_ai", "ai"),
                          ("toggle_presets", "presets"), ("toggle_adjustments", "adjustments")):
        # Start from another tool to prove routing, not an already-true state.
        s.tab("crop" if panel == "presets" else "presets")
        s.record("shortcut-" + panel, lambda action=action: s.shortcut(action),
                 lambda r, panel=panel: active(r, panel), s.keyreq(action))
    for action, label in (("toggle_metadata", "Metadata"), ("toggle_export", "Export")):
        s.record("shortcut-modal-" + label.lower(), lambda action=action: s.shortcut(action), s.modal(label), s.keyreq(action))
        s.record("shortcut-modal-close-" + label.lower(), lambda: s.key("Escape"), lambda r: not r["dialogs"],
                 [req("keydown", code="Escape"), req("keyup", code="Escape")])


def group_brush(s):
    s.mask_baseline = None
    s.tab("masks")
    check(not s.snapshot()["masks"], "Fresh fixture unexpectedly has masks; refusing to reset data")
    # Resolve the exact rendered tile after the real Masks content has mounted.
    # "Match Brush" must not match; no ancestor props guess is needed here.
    brush = """(() => {const root=toolsSmoke.one('[data-panel=masks]');
      const all=[...root.querySelectorAll('[role=button]')].filter(n=>n.innerText.trim()==='Brush');
      if(all.length!==1)throw Error('Missing/ambiguous real Brush tile');return all[0];})()"""
    s.record("brush-create-real-ui", lambda: s.click_expr(brush, "create-brush"),
             lambda r: active(r, "masks") and len(r["masks"]) == 1 and r["activeMaskId"] is not None and
             r["masks"][0]["subMasks"][0]["type"] == "brush", [req("click", "create-brush")])
    baseline = copy.deepcopy(s.snapshot()["masks"])
    # Konva's top interactive canvas receives genuine pointer events. Do not
    # fake a stroke by setting parameters.lines or calling updateSubMask.
    canvas = """(() => {const all=toolsSmoke.canvasNodes('.konvajs-content').filter(n=>
        [...n.querySelectorAll('canvas')].some(toolsSmoke.visible));
      if(all.length!==1)throw Error('Missing/ambiguous real mask drawing stage');return all[0];})()"""
    def drawn(r):
        sub = r["masks"][0]["subMasks"][0] if r["masks"] else {}
        lines = sub.get("parameters", {}).get("lines", [])
        return (active(r, "masks") and r["masks"] != baseline and bool(lines) and
                any(len(line.get("points", [])) >= 2 for line in lines))
    s.record("brush-draw-on-real-canvas", lambda: s.drag(canvas, "mask-drawing-canvas", 36, 18, 0.45, 0.45), drawn,
             [req("pointerdown", "mask-drawing-canvas"), req("pointermove"), req("pointerup")], timeout=25)
    s.mask_baseline = copy.deepcopy(s.snapshot()["masks"])
    s.record("brush-presets-retains-data", lambda: s.tab("presets"),
             lambda r: active(r, "presets") and r["masks"] == s.mask_baseline, [req("click", "tab-presets")])
    s.record("brush-return-retains-data", lambda: s.tab("masks"),
             lambda r: active(r, "masks") and r["masks"] == s.mask_baseline, [req("click", "tab-masks")])


def group_narrow(s):
    # Width is changed through the actual sidebar resizer, with geometry measured.
    before = next(p["width"] for p in s.snapshot()["sidebars"] if p["side"] == "left")
    s.record("left-width-250", lambda: s.drag("toolsSmoke.one('.cursor-col-resize',toolsSmoke.side('left').node,false)",
             "left-width-divider", 250 - before, 0),
             lambda r: any(p["side"] == "left" and abs(p["width"] - 250) < 1 for p in r["sidebars"]),
             [req("pointerdown", "left-width-divider"), req("pointermove"), req("pointerup")])
    for panel in ("masks", "ai"):
        def inspect(panel=panel):
            s.tab(panel)
            s.driver.wait_js(s.cdp, "toolsSmoke.snapshot().panels.some(p=>p.panel===" + json.dumps(panel) + "&&p.content.matched)")
            controls = s.js("toolsSmoke.controls(" + json.dumps(panel) + ")")
            s.details["controlGeometry"] = controls
            check(controls and all(c["horizontalFit"] for c in controls), "250px control rectangle clipped in " + panel)
            # Test-only idle: avoid capturing the mounted panel mid fade.
            # This is not a product latency measurement or acceptance budget.
            time.sleep(0.4)
            s.frame()
            s.details["captureSettling"] = {"idleSeconds": 0.4, "animationFrames": 2, "productLatencyMeasurement": False}
            s.screenshot("narrow-250-" + panel)
        s.record("narrow-controls-" + panel, inspect, lambda r, panel=panel: active(r, panel), [req("click", "tab-" + panel)])
    # A real local AI tile is usable without a provider/model; do not draw or
    # press Generate (those actions may start a backend model job).
    s.record("ai-local-ui-tile", lambda: s.click_expr("""(() => {const root=toolsSmoke.one('[data-panel=ai]');
      const n=[...root.querySelectorAll('[role=button]')].filter(n=>n.innerText.trim()==='Clone');
      if(n.length!==1)throw Error('Missing/ambiguous Clone tile');return n[0];})()""", "ai-clone-tile"),
             lambda r: active(r, "ai") and len(r["aiPatches"]) == 1 and
             r["aiPatches"][0]["subMasks"][0]["type"] == "clone", [req("click", "ai-clone-tile")])


def group_viewports(s):
    for width, height in ((1280, 720), (800, 600)):
        prefix = str(width) + "x" + str(height)
        s.resize(width, height)
        s.tab("curves")
        s.tab("masks")
        for region in ("leftTop", "leftBottom"):
            def wheel(region=region):
                expression = "toolsSmoke.scrollTarget(" + json.dumps(region) + ")"
                s.driver.wait_js(s.cdp, "(() => {try{return !!(" + expression + ")}catch{return false}})()")
                point = s.point(expression, "scroll-" + region)
                s.details["scrollGeometry"] = s.js("(() => {const n=(" + expression + ");return {clientHeight:n.clientHeight,scrollHeight:n.scrollHeight," +
                    "scope:n.closest('[data-panel-region]')?.dataset.panelRegion??'left-column'}})()")
                initial = s.js("(" + expression + ").scrollTop")
                sign = -1 if initial > 1 else 1
                s.details["scrollBefore"] = initial
                s.cdp.call("Input.dispatchMouseEvent", {"type": "mouseWheel", **point, "deltaX": 0, "deltaY": sign * 220})
                s.driver.wait_js(s.cdp, "(" + expression + ").scrollTop!==" + str(initial))
                s.details["scrollAfter"] = s.js("(" + expression + ").scrollTop")
            s.record(prefix + "-scroll-" + region, wheel,
                     lambda r: r["layoutMode"] == "full" and (r["viewport"]["width"], r["viewport"]["height"]) == (width, height),
                     [req("wheel", "scroll-" + region)])
        def divider():
            s.details["splitBefore"] = s.js("toolsSmoke.one('[data-panel-region=leftTop]').getBoundingClientRect().toJSON()")
            delta = 34 if s.details["splitBefore"]["height"] <= 255 else -30
            s.drag("toolsSmoke.divider()", "left-split-divider", 0, delta)
            s.details["splitAfter"] = s.js("toolsSmoke.one('[data-panel-region=leftTop]').getBoundingClientRect().toJSON()")
            if abs(s.details["splitAfter"]["height"] - s.details["splitBefore"]["height"]) <= 2:
                s.details["firstDragAtBoundary"] = s.details["splitAfter"]
                s.drag("toolsSmoke.divider()", "left-split-divider", 0, -delta * 2)
                s.details["splitAfter"] = s.js("toolsSmoke.one('[data-panel-region=leftTop]').getBoundingClientRect().toJSON()")
            check(abs(s.details["splitAfter"]["height"] - s.details["splitBefore"]["height"]) > 2,
                  "Divider input did not change actual top-region geometry (both directions tried at boundary)")
        s.record(prefix + "-divider-real-drag", divider,
                 lambda r: fixed(r, s.report["tetheringSupported"]),
                 [req("pointerdown", "left-split-divider"), req("pointermove"), req("pointerup")])


def group_collapsed(s):
    for action, panel in (("toggle_crop_panel", "crop"), ("toggle_masks", "masks"), ("toggle_ai", "ai"), ("toggle_presets", "presets")):
        s.tab("presets" if panel != "presets" else "crop")
        s.record("collapse-before-" + panel, lambda: s.shortcut("toggle_left_panel"),
                 lambda r: not any(p["region"].startswith("left") for p in r["panels"]), s.keyreq("toggle_left_panel"))
        s.record("collapsed-shortcut-reopens-" + panel, lambda action=action: s.shortcut(action),
                 lambda r, panel=panel: active(r, panel) and any(p["side"] == "left" and p["visible"] and p["width"] >= 200 for p in r["sidebars"]),
                 s.keyreq(action))


def group_compact(s):
    s.resize(600, 800)
    for panel in ("crop", "masks", "ai", "presets", "adjustments", "metadata", "export"):
        def select(panel=panel):
            s.click_expr("toolsSmoke.mobile(" + json.dumps(panel) + ")", "mobile-" + panel)
        def usable(r, panel=panel):
            if not active(r, panel, compact=True) or r["dialogs"] or (r["viewport"]["width"], r["viewport"]["height"]) != (600, 800):
                return False
            if panel == "metadata":
                return s.js("document.body.innerText.includes('Metadata')&&document.body.innerText.includes(" + json.dumps(PHOTO.name) + ")")
            if panel == "export":
                return s.js("[...document.querySelectorAll('button')].some(n=>toolsSmoke.visible(n)&&n.innerText.trim()==='Export Image'&&!n.disabled)")
            if panel == "adjustments":
                return s.js("[...document.querySelectorAll('[data-speed-edit-id=exposure] input[type=range]')].some(toolsSmoke.visible)")
            return s.js("!!toolsSmoke.component(p=>typeof p?.onPanelSelect==='function'&&Object.hasOwn(p,'activePanel'))")
        s.record("compact-" + panel, select, usable, [req("click", "mobile-" + panel)])
        if panel == "masks":
            initial = s.js("toolsSmoke.compactWaveform()")
            check(initial["buttonEnabled"] and initial["buttonVisible"] and not initial["rightAdjustmentsVisible"],
                  "Compact Masks waveform is disabled by a non-rendered right Adjustments panel")
            for suffix, wanted in (("toggle", 0 if initial["mounted"] else 1), ("restore", initial["mounted"])):
                def wave(r, wanted=wanted):
                    observed = s.js("toolsSmoke.compactWaveform()")
                    s.details["actualCompactWaveform"] = observed
                    return (active(r, "masks", compact=True) and observed["buttonEnabled"] and
                            not observed["rightAdjustmentsVisible"] and observed["mounted"] == wanted and
                            (wanted == 0 or observed["visible"] > 0))
                s.record("compact-masks-waveform-" + suffix,
                         lambda: s.click_expr("toolsSmoke.one('button:has(svg.lucide-chart-area)',toolsSmoke.compactContentRoot(),false)", "compact-waveform"),
                         wave, [req("click", "compact-waveform")])


def group_centre(s):
    s.shortcut("toggle_adjustments")
    target = RIGHT + ' [data-center-marker-controls="vignette"] [data-speed-edit-id="vignetteAmount"] input[type="range"]'
    def proof(r, ordinary):
        evidence = s.js("toolsSmoke.overlayEvidence()")
        s.details["actualImageCanvasStage"] = evidence
        if ordinary:
            return (not any(r["mode"].values()) and any(e["visible"] and e["centres"] == 1 and
                    any(f["nontransparent"] > 0 for f in e["frames"]) for e in evidence))
        return all(e["centres"] == 0 for e in evidence)
    s.record("centre-ordinary-real-control-canvas", lambda: s.click(target, "vignette-control", fx=0.58),
             lambda r: proof(r, True), [req("pointerdown", "vignette-control"), req("pointerup", "vignette-control")])
    for panel in ("crop", "masks"):
        s.record("centre-suppressed-" + panel, lambda panel=panel: (s.tab(panel), s.click(target, "vignette-control", fx=0.63)),
                 lambda r, panel=panel: active(r, panel) and proof(r, False),
                 [req("click", "tab-" + panel), req("pointerdown", "vignette-control"), req("pointerup", "vignette-control")])


def group_relight(s):
    restored = s.snapshot()["relight"]
    s.report["restoredRelightBeforeControls"] = restored
    s.report["restoredRelightMapDiagnostics"] = s.relight_map_diagnostics()
    check(restored["observable"] and restored["enabled"],
          "Persisted model-free Relight seed did not restore to the current right Effects section")
    target = RIGHT + ' [data-relight-lights] button[aria-label="Add Light"]'
    s.shortcut("toggle_adjustments")

    def proof(r, before, ordinary):
        evidence = s.js("toolsSmoke.overlayEvidence()")
        s.details["actualImageCanvasStage"] = evidence
        s.details["normalMapDiagnostics"] = s.relight_map_diagnostics()
        relight = r["relight"]
        if not relight["observable"] or not relight["enabled"] or len(relight["lights"]) != before + 1:
            return False
        if ordinary:
            return (not any(r["mode"].values()) and any(e["visible"] and e["lights"] >= 1 and
                    any(f["nontransparent"] > 0 for f in e["frames"]) for e in evidence))
        return all(e["lights"] == 0 for e in evidence)

    before = len(s.snapshot()["relight"]["lights"])
    s.record("relight-ordinary-add-light-real-canvas", lambda: s.click(target, "relight-add-light"),
             lambda r: proof(r, before, True), [req("click", "relight-add-light")])
    for panel in ("crop", "masks"):
        before = len(s.snapshot()["relight"]["lights"])
        s.record("relight-suppressed-" + panel,
                 lambda panel=panel: (s.tab(panel), s.click(target, "relight-add-light")),
                 lambda r, panel=panel, before=before: active(r, panel) and proof(r, before, False),
                 [req("click", "tab-" + panel), req("click", "relight-add-light")])
    before = len(s.snapshot()["relight"]["lights"])
    s.record("relight-return-adjustments-reactivates",
             lambda: (s.shortcut("toggle_adjustments"), s.click(target, "relight-add-light")),
             lambda r: proof(r, before, True), s.keyreq("toggle_adjustments") + [req("click", "relight-add-light")])


def group_no_image(s):
    s.empty = True
    s.resize(1280, 720)
    def guarded(r):
        tabs = {t["panel"]: t["disabled"] for t in r["tabs"]}
        return (r["canvasCount"] == 0 and r["editorViewCount"] == 0 and
                all(tabs.get(p) is True for p in ("crop", "masks", "ai")) and
                all(h["mounted"] and h["disabled"] for h in r["disabledHeader"]) and
                not any(p["panel"] in ("crop", "masks", "ai") for p in r["panels"]) and
                any(p["panel"] == "presets" and p["region"] == "leftBottom" for p in r["panels"]) and
                any(p["panel"] == "curves" and 'No image selected.' in p["text"] for p in r["panels"]))
    for action in ("toggle_crop_panel", "toggle_masks", "toggle_ai"):
        s.record("no-image-guard-" + action, lambda action=action: s.shortcut(action), guarded, s.keyreq(action))


RUNNERS = dict(zip(GROUPS[:-1], (group_migration, group_modes, group_crop, group_keyboard, group_brush,
                           group_narrow, group_viewports, group_collapsed, group_centre, group_relight, group_compact)))


def seed_settings():
    # AI-free hides Spatial/Relight entirely. The supported local CPU profile
    # exposes restored controls without a connector or a generation request.
    return {"language": "en", "decorations": False, "keybinds": {}, "aiProvider": "cpu",
            "enableXmpSync": False, "createXmpIfMissing": False,
            "rootFolders": [str(PHOTO.parent)], "lastRootPath": str(PHOTO.parent),
            "grouping": "off", "libraryViewMode": "recursive",
            "uiVisibility": {"leftPanel": True, "rightPanel": True, "filmstrip": True, "quickFilter": False},
            "lastFolderState": {"currentFolderPath": str(PHOTO.parent), "expandedFolders": [str(PHOTO.parent)],
                                "activeAlbumId": None, "expandedAlbumGroups": []},
            "adjustmentLayout": {"openSections": {"basic": True, "curves": True, "color": True, "details": True, "effects": True}},
            "workspace": {"leftPanelWidth": 350, "rightPanelWidth": 350, "leftTopHeight": 340, "rightTopHeight": 450,
                          # Hostile but parseable OLD layout: wrong regions,
                          # active tools and placements; dimensions must survive.
                          "panelLayout": {"leftTop": ["metadata", "export", "masks"], "leftBottom": ["adjustments", "ai"],
                                          "rightTop": ["crop", "presets", "folderTree", "tethering"], "rightBottom": ["curves"]},
                          "activePanels": {"leftTop": "masks", "leftBottom": "ai", "rightTop": "crop", "rightBottom": "curves"},
                          "panelSwitcherPlacement": {"leftTop": "left", "leftBottom": "left", "rightTop": "right", "rightBottom": "right"}}}


def owned_hwnd(process):
    handles = []
    win32gui.EnumWindows(lambda h, _: handles.append(h) if win32process.GetWindowThreadProcessId(h)[1] == process.pid
                         and win32gui.IsWindowVisible(h) and win32gui.GetWindowText(h) == TITLE else None, None)
    check(len(handles) == 1, "Expected exactly one owned TBT HWND")
    return handles[0]


def stop_owned(process, hwnd):
    if process is None or process.poll() is not None:
        return
    if hwnd is not None and win32gui.IsWindow(hwnd) and win32process.GetWindowThreadProcessId(hwnd)[1] == process.pid:
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=20)
    check(process.poll() is not None, "Owned process still running")


def process_table():
    """Read PID ancestry only, without recording other apps' command lines."""
    import ctypes
    from ctypes import wintypes as w

    class Entry(ctypes.Structure):
        _fields_ = [("size", w.DWORD), ("usage", w.DWORD), ("pid", w.DWORD),
                    ("heap", ctypes.c_size_t), ("module", w.DWORD), ("threads", w.DWORD),
                    ("parent", w.DWORD), ("priority", w.LONG), ("flags", w.DWORD), ("exe", w.WCHAR * 260)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32FirstW.restype = kernel.Process32NextW.restype = w.BOOL
    kernel.CloseHandle.argtypes = [w.HANDLE]
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    check(handle != ctypes.c_void_p(-1).value, "Cannot snapshot process ownership")
    result = {}
    try:
        entry = Entry()
        entry.size = ctypes.sizeof(entry)
        more = kernel.Process32FirstW(handle, ctypes.byref(entry))
        check(bool(more), "Cannot read process ownership snapshot")
        while more:
            result[entry.pid] = {"pid": entry.pid, "parent": entry.parent, "exe": entry.exe}
            more = kernel.Process32NextW(handle, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(handle)
    return result


def process_token(pid, terminate_token=None):
    """Creation-time guard prevents killing an unrelated process reusing a PID."""
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
        # ERROR_INVALID_PARAMETER means the process has already exited.
        check(ctypes.get_last_error() == 87, "Cannot query owned process " + str(pid))
        return None
    try:
        exit_code = w.DWORD()
        check(kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)), "Cannot query owned process exit code")
        if exit_code.value != 259:
            return None
        created, exited, cpu, user = (w.FILETIME() for _ in range(4))
        check(kernel.GetProcessTimes(handle, *map(ctypes.byref, (created, exited, cpu, user))), "Cannot read process creation time")
        token = (created.dwHighDateTime << 32) | created.dwLowDateTime
        if terminate_token is not None and token == terminate_token:
            check(kernel.TerminateProcess(handle, 1), "Cannot stop owned descendant " + str(pid))
        return token
    finally:
        kernel.CloseHandle(handle)


def owned_descendants(process, root_token):
    table, owners = process_table(), {process.pid}
    while True:
        children = {pid for pid, row in table.items() if row["parent"] in owners}
        if children <= owners:
            break
        owners |= children
    result = []
    for pid in sorted(owners - {process.pid}):
        token = process_token(pid)
        if token is not None and token >= root_token:
            result.append({**table[pid], "creationToken": token})
    return result


def stop_tree(process, hwnd, root_token, report):
    # Set the proof only after every ownership query and exit check succeeds.
    # An exception at any earlier point must leave restoration unauthorized.
    report["ownedTreeShutdownVerified"] = False
    before = owned_descendants(process, root_token)
    report["ownedDescendantsBeforeClose"] = before
    stop_owned(process, hwnd)
    # WebView2 children normally stop themselves. Wait briefly, then terminate
    # only descendants whose PID AND creation time were captured as ours.
    known = {p["pid"]: p for p in before + owned_descendants(process, root_token)}
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        alive = [p for p in known.values() if process_token(p["pid"]) == p["creationToken"]]
        if not alive:
            break
        time.sleep(0.1)
    for row in alive:
        process_token(row["pid"], terminate_token=row["creationToken"])
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        remaining = [p for p in known.values() if process_token(p["pid"]) == p["creationToken"]]
        if not remaining:
            break
        time.sleep(0.1)
    report["ownedDescendantsRemaining"] = remaining
    check(not remaining, "Owned WebView2 descendants remain alive")
    check(process.poll() is not None, "Owned root has not exited")
    report["ownedTreeShutdownVerified"] = True


def profile_restore_allowed(launch_attempted, preflight_quiet, tree_shutdown_verified, root_exited):
    # Before any launch, explicit quiet preflight is sufficient. After even a
    # failed launch attempt, only a successful owned-tree shutdown proves quiet.
    return bool(root_exited and (tree_shutdown_verified is True if launch_attempted else preflight_quiet is True))


def collect_observations(cdp):
    cdp.js("toolsSmoke.assertHook()")
    result = {"observerHook": cdp.js("toolsSmoke.hookStatus()"), "nativeCalls": cdp.js("toolsSmoke.calls"),
              "selectionChanges": cdp.js("toolsSmoke.selectionChanges"), "observerErrors": cdp.js("toolsSmoke.errors")}
    check(not result["selectionChanges"] and not result["observerErrors"], "Selection/observation errors")
    forbidden = [c["command"] for c in result["nativeCalls"] if c["command"] == "export_images" or
                 re.search(r"download.*model|generate_ai_|generate_full_image_depth_map|generate_relight_normal_map|inpaint|generative_replace", c["command"])]
    check(not forbidden, "Unexpected heavy/export backend commands: " + repr(forbidden))
    result["forbiddenNativeCommands"] = forbidden
    return result


def main():
    global win32gui, win32con, win32process
    # Refusal paths cannot write into existing evidence/output. All other normal
    # failures, including preflight/import/setup failures, get a false record.
    check(not OUTPUT.exists() and not OUTPUT.is_symlink() and not (PHOTO.parent / "output").exists() and not (ROOT / "output").exists(),
          "Refuse existing evidence or output; use a fresh parent staging directory")
    check(not (ROOT / "profile-backup").exists() and not (ROOT / "profile-backup").is_symlink(),
          "Refuse existing private profile backup; parent must archive it after recovery verification")
    check(not any(p.exists() or p.is_symlink() for p in (OUT / "visual-review-request.json", OUT / "visual-review.json", ROOT / "parent-visual-review.json")),
          "Refuse existing visual-review artifacts; use fresh staging")
    OUT.mkdir(parents=True, exist_ok=True)
    evidence = OUTPUT.open("x", encoding="utf-8")
    report = {"schema": "rapidraw-tool-layout-windows-smoke-v1", "started": stamp(), "passed": False,
              "coverageComplete": False, "nativePlanComplete": False, "subsetPassed": False, "scriptSha256": sha(Path(__file__)), "setup": [], "groups": [], "cases": [],
              "plannedGroups": list(GROUPS), "pendingParentChecks": [{"id": k, "requirement": v} for k, v in PENDING.items()],
              "launchAttempted": False, "ownedTreeShutdownVerified": False, "shutdownState": "unverified",
              "limits": ["Static authoring is not a Windows run. Only successful real-app case evidence certifies the automated subset.",
                         "The native no-image plan uses reachable library sidebars. App.tsx only mounts EditorView with selectedImage; an empty EditorView is not an acceptance requirement.",
                         "Same-session selected-image loss/reset uses parent's separate browser/store evidence, not this independent no-selection launch.",
                         "Relight cases validate control routing and actual overlay drawing/suppression with an enabled persisted fixture; no lighting quality or normal-map correctness is certified.",
                         "A restored null/empty map makes native relight::prepare return None; existing cached maps are allowed and diagnosed by type/length/hash. No assertion of absent backend lighting or lighting quality is made when a cached map exists.",
                         "No export backend rewrite, export submission, heavy generation, credentials or model downloads."]}
    original = {}
    process = cdp = smoke = None
    hwnd = None
    expected_sha = None
    measured_ok = False
    profile_mutated = False
    root_token = None
    preflight_quiet = False
    launch_attempted = False
    tree_shutdown_verified = False
    try:
        check(os.name == "nt", "Run only in parent's interactive Windows desktop")
        import win32con
        import win32gui
        import win32process
        check(EXE.is_file(), "Parent must build/stage RapidRAW-tools.exe")
        existing = []
        win32gui.EnumWindows(lambda h, _: existing.append(h) if win32gui.GetWindowText(h) == TITLE else None, None)
        check(not existing, "Close existing TBT windows before touching the fork profile")
        check(not any(p["exe"].lower() == EXE.name.lower() for p in process_table().values()),
              "A tools EXE process already exists, including potentially hidden windows")
        with socket.socket() as probe_socket:
            # Baseline driver attaches to port 9431. Refuse a pre-existing CDP
            # listener instead of accidentally driving an unrelated WebView.
            probe_socket.bind(("127.0.0.1", 9431))
        report["cdpPortInitiallyFree"] = True
        preflight_quiet = True
        report["quietPreflightVerified"] = True
        for name, frozen_sha in FROZEN.items():
            actual = sha(ROOT / name)
            report.setdefault("baselineHashes", {})[name] = actual
            check(actual == frozen_sha, "Immutable baseline helper changed: " + name)
        report["exeSha256"] = sha(EXE)
        manifests = [p for p in (ROOT / "fixture.json", OUT / "fixture.json") if p.is_file()]
        check(len(manifests) == 1, "Stage exactly one fixture.json at ROOT or evidence")
        fixture = json.loads(manifests[0].read_text(encoding="utf-8-sig"))
        expected_sha = fixture.get("sha256", fixture.get("sha", "")).lower()
        check(expected_sha == NASA_SHA256 and Path(fixture["path"]).resolve() == PHOTO.resolve() and fixture.get("sourceRel"),
              "Fixture manifest must identify authorized isolated NASA RAW")
        check(PHOTO.is_file() and not PHOTO.is_symlink() and sha(PHOTO) == expected_sha, "Original fixture SHA/path mismatch")
        check(list(PHOTO.parent.iterdir()) == [PHOTO], "Fresh isolated fixture directory must initially contain only RAW")
        report.update(fixture=fixture, fixtureSha256Before=sha(PHOTO), keyboardDefaults=keyboard_defaults())
        seed_fixture_metadata(report)
        config = Path(os.environ["APPDATA"]) / "io.github.tursom.RapidRAW"
        for p in (config / "settings.json", config / "window_state.json"):
            original[p] = p.read_bytes() if p.exists() else None
        report["profileBefore"] = [{"file": p.name, "existed": b is not None,
                                     "sha256": hashlib.sha256(b).hexdigest() if b is not None else None} for p, b in original.items()]
        backup_profiles(original, report)
        # Driver import has a baseline OUT.mkdir side effect. Redirect only its
        # module configuration AFTER immutable-file verification; never edit it.
        spec = importlib.util.spec_from_file_location("tool_layout_windows_driver", ROOT / "windows-cdp.py")
        driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(driver)
        driver.ROOT, driver.OUT, driver.EXE = ROOT, OUT, EXE
        (ROOT / "logs").mkdir(exist_ok=True)
        config.mkdir(parents=True, exist_ok=True)
        seed = seed_settings()
        report["seedWorkspace"] = seed["workspace"]
        report["seedAiProvider"] = {"value": seed["aiProvider"], "reason": "Expose Spatial/Relight UI; no connector, model generation or download is requested"}
        profile_mutated = True
        (config / "settings.json").write_text(json.dumps(seed), encoding="utf-8")
        launch_attempted = report["launchAttempted"] = True
        tree_shutdown_verified = False
        report["ownedTreeShutdownVerified"] = False
        report["shutdownState"] = "unverified-launch-attempt"
        process, cdp, timing = driver.launch()
        root_token = process_token(process.pid)
        check(root_token is not None, "Owned app exited before process ownership capture")
        report["launch"] = timing
        report["browser"] = cdp.call("Browser.getVersion")
        hwnd = owned_hwnd(process)
        smoke = Smoke(driver, process, cdp, hwnd, report)
        driver.wait_js(cdp, "[...document.querySelectorAll('button')].some(n=>/Continue Session/i.test(n.innerText))")
        smoke.js((ROOT / "observe.js").read_text(encoding="utf-8"))
        smoke.js(OBSERVER_JS)
        probe = smoke.js("toolsSmoke.probe()")
        report.update(observerProbe=probe, tetheringSupported=probe["tethering"])
        report["setup"].append({"kind": "synthetic-library-navigation", "reason": "Setup only, excluded from measured cases"})
        smoke.js("[...document.querySelectorAll('button')].find(n=>/Continue Session/i.test(n.innerText)).click()")
        driver.wait_js(cdp, "baseline.thumbnailCoverage().expected===1&&baseline.thumbnailCoverage().missing===0", timeout=120)
        smoke.js("document.querySelector('[data-bench-id=thumbnail]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
        driver.wait_js(cdp, "baseline.filmstrip()?.selectedImage?.isReady", timeout=120)
        driver.wait_js(cdp, "toolsSmoke.canvas().p.hasRenderedFirstFrame", timeout=120)
        time.sleep(0.5)
        smoke.js("toolsSmoke.expectedPath=" + json.dumps(str(PHOTO)) + ";toolsSmoke.armed=true")
        for name in GROUPS[:-1]:
            smoke.group = name
            row = {"name": name, "passed": False}
            report["groups"].append(row)
            start = len(report["cases"])
            try:
                if name != "migration":
                    smoke.reset_group()
                RUNNERS[name](smoke)
                check(len(report["cases"]) > start and all(c["passed"] for c in report["cases"][start:]), "Group did not finish measured cases")
                row["passed"] = True
            except Exception:
                row["error"] = traceback.format_exc()
                report["pendingParentChecks"].append({"id": "failed-group-" + name, "requirement": "Resolve failed/unfinished assertions in " + name})
            row["caseNames"] = [c["name"] for c in report["cases"][start:]]
        # Independent native launch: no editor/store setters and no selected
        # image. The frozen UI has no empty EditorView route; test the actual
        # reachable library sidebars, explicitly retaining that coverage limit.
        report["imagePhaseObservation"] = collect_observations(cdp)
        cdp.close()
        cdp = None
        first_shutdown = {}
        report["imagePhaseShutdown"] = first_shutdown
        stop_tree(process, hwnd, root_token, first_shutdown)
        tree_shutdown_verified = first_shutdown["ownedTreeShutdownVerified"] is True
        report["ownedTreeShutdownVerified"] = tree_shutdown_verified
        check(tree_shutdown_verified, "Image-phase tree shutdown is unverified; refuse profile reseed")
        check(process.poll() is not None, "Image-phase app still alive")
        process = None
        hwnd = None
        root_token = None
        (config / "settings.json").write_text(json.dumps(seed_settings()), encoding="utf-8")
        tree_shutdown_verified = False
        report["ownedTreeShutdownVerified"] = False
        report["shutdownState"] = "unverified-launch-attempt"
        process, cdp, no_image_timing = driver.launch()
        root_token = process_token(process.pid)
        check(root_token is not None, "No-image app exited before ownership capture")
        hwnd = owned_hwnd(process)
        smoke = Smoke(driver, process, cdp, hwnd, report)
        smoke.empty, smoke.group = True, "no-image"
        report["noImageLaunch"] = no_image_timing
        driver.wait_js(cdp, "[...document.querySelectorAll('button')].some(n=>/Continue Session/i.test(n.innerText))")
        smoke.js((ROOT / "observe.js").read_text(encoding="utf-8"))
        smoke.js(OBSERVER_JS)
        report["noImageProbe"] = smoke.js("toolsSmoke.probe()")
        # Setup navigation is itself trusted here. No fixture double-click.
        smoke.click_expr("[...document.querySelectorAll('button')].find(n=>/Continue Session/i.test(n.innerText))", "no-image-continue")
        driver.wait_js(cdp, "!!document.querySelector('[data-panel=curves] button[aria-label=Info]')", timeout=60)
        row = {"name": "no-image", "passed": False}
        report["groups"].append(row)
        start = len(report["cases"])
        try:
            group_no_image(smoke)
            row["passed"] = True
        except Exception:
            row["error"] = traceback.format_exc()
            report["pendingParentChecks"].append({"id": "failed-group-no-image", "requirement": "Resolve no-selection sidebar/keyboard assertions"})
        row["caseNames"] = [c["name"] for c in report["cases"][start:]]
        measured_ok = (len(report["groups"]) == len(GROUPS) and all(g["passed"] for g in report["groups"]) and
                       bool(report["cases"]) and all(c["passed"] for c in report["cases"]))
        if measured_ok:
            await_visual_review(report)
    except Exception:
        measured_ok = False
        report["error"] = traceback.format_exc()
    finally:
        cleanup_errors = []
        if cdp is not None:
            try:
                report["finalObservation"] = collect_observations(cdp)
            except Exception:
                report["finalObservationError"] = traceback.format_exc()
                measured_ok = False
            try:
                cdp.close()
            except Exception:
                cleanup_errors.append("CDP close: " + traceback.format_exc())
        try:
            if process is not None and root_token is not None:
                tree_shutdown_verified = False
                stop_tree(process, hwnd, root_token, report)
                tree_shutdown_verified = report["ownedTreeShutdownVerified"] is True
            else:
                stop_owned(process, hwnd)
        except Exception:
            cleanup_errors.append("Owned shutdown: " + traceback.format_exc())
            try:
                stop_owned(process, hwnd)
            except Exception:
                cleanup_errors.append("Fallback owned shutdown: " + traceback.format_exc())
        report["processStopped"] = profile_restore_allowed(launch_attempted, preflight_quiet, tree_shutdown_verified,
                                                           process is None or process.poll() is not None)
        report["shutdownState"] = ("verified-owned-tree" if tree_shutdown_verified else
                                   "verified-preflight-no-launch" if report["processStopped"] else "unverified")
        # A live app may overwrite a restored profile. Never declare restoration
        # successful while it can still write, or terminate an unowned process.
        if profile_mutated and report["processStopped"]:
            for p, data in original.items():
                try:
                    if data is None:
                        p.unlink(missing_ok=True)
                    else:
                        p.write_bytes(data)
                except Exception:
                    cleanup_errors.append("Restore " + p.name + ": " + traceback.format_exc())
        elif profile_mutated:
            cleanup_errors.append("Profile restoration withheld: owned-tree shutdown is unverified (root exit/absent descendant fields are insufficient)")
        if launch_attempted and not tree_shutdown_verified:
            report["shutdownUnverifiedReason"] = "No successful owned-tree shutdown proof; a failed launcher or fallback root-only stop does not establish descendant exit."
        try:
            report["profileRestored"] = report["processStopped"] and bool(original) and all((p.read_bytes() if p.exists() else None) == data for p, data in original.items())
            report["profileAfter"] = [{"file": p.name, "existed": p.exists(), "sha256": sha(p) if p.exists() else None} for p in original]
        except Exception:
            report["profileRestored"] = False
            cleanup_errors.append("Profile readback: " + traceback.format_exc())
        try:
            report["fixtureSha256After"] = sha(PHOTO)
            report["rawBytesUnchanged"] = expected_sha == NASA_SHA256 == report["fixtureSha256After"]
        except Exception:
            report["rawBytesUnchanged"] = False
            cleanup_errors.append("Fixture readback: " + traceback.format_exc())
        try:
            report["baselineUnchanged"] = all(sha(ROOT / name) == value for name, value in FROZEN.items())
        except Exception:
            report["baselineUnchanged"] = False
        report["cleanupErrors"] = cleanup_errors
        report["subsetPassed"] = bool(measured_ok and report["processStopped"] and report["profileRestored"] and
                                      report["rawBytesUnchanged"] and report["baselineUnchanged"] and
                                      not cleanup_errors and not report.get("selectionChanges"))
        report["nativePlanComplete"] = bool(report["subsetPassed"] and [g["name"] for g in report["groups"]] == list(GROUPS))
        report["coverageComplete"] = bool(report["subsetPassed"] and not report["pendingParentChecks"] and
                                          [g["name"] for g in report["groups"]] == list(GROUPS))
        report["passed"] = report["coverageComplete"]
        report["finished"] = stamp()
        try:
            json.dump(report, evidence, indent=2, ensure_ascii=False)
            evidence.write("\n")
            evidence.flush()
            os.fsync(evidence.fileno())
        finally:
            evidence.close()
    print(json.dumps({"passed": report["passed"], "subsetPassed": report["subsetPassed"], "nativePlanComplete": report["nativePlanComplete"], "coverageComplete": report["coverageComplete"],
                      "cases": len(report["cases"]), "evidence": str(OUTPUT), "pendingParentChecks": report["pendingParentChecks"]}))
    return 0 if report["passed"] else (2 if report["subsetPassed"] else 1)


if __name__ == "__main__":
    raise SystemExit(main())
