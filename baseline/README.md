# Task 1 baseline measurement protocol (v3)

[../BASELINE.md](../BASELINE.md) records the Windows v3 results and remaining
acceptance gaps. Both conditions completed on 2026-11-07; the committed
[final evidence](evidence/windows/) contains six startups and forty balanced
switches per condition, plus isolated mouse-drag checks. macOS, removable-drive
and human visual checks remain pending. These scripts observe the full release
application and are never bundled into it. Stage 1 acceptance remains pending;
task 10 is prohibited until that prerequisite passes.

The v3 samples and their script hashes refer to commit `9588e26c`, before the
independent window-size fix. Compare historical hashes against that revision,
not subsequent application or driver changes. The current driver defaults to a
720px state seed for the corrected window; no historical raw values are changed.

## Workload

[sources.json](sources.json) pins URLs, SHA-256 and credits for two genuine Nikon
NEFs from NASA astronaut photography, mirrored in rawpy's test set. NASA's
[conditions of use](https://eol.jsc.nasa.gov/FAQ/) state that NASA does not maintain
copyright in these photographs. Credit: Earth Science and Remote Sensing Unit,
NASA Johnson Space Center; <https://eol.jsc.nasa.gov/>. Photo binaries are not
committed.

Download both into an empty source directory. With Python, `rawpy` and Pillow:

```sh
python baseline/scripts/make-fixture.py SOURCE_DIR NEW_OUTPUT_DIR
```

The generator verifies hashes, decodes both RAWs with LibRaw, and creates 82
byte-identical RAW copies plus 82 full-resolution JPEG derivatives in four
folders, including `日本語 [set b]`. It refuses an existing output directory.
The 164-entry manifest records duplication: two source photographs cannot
represent a diverse camera collection. The generated workload has no removable
drive; external-drive coverage still requires separate real measurements.

## Windows interface and prerequisites

The [scripts/windows-cdp.py](scripts/windows-cdp.py) driver fixes these paths:

- Workspace: `E:\projects\tbt\rapidraw-baseline`.
- App source/replay: `app`; executable: `app\src-tauri\target\release\RapidRAW.exe`.
- Disposable fixture and manifest: `fixtures\manifest.json`.
- Existing `logs` directory, with app stdout appended to `logs\app-stdout.log`.
- Raw output directory: `evidence` (created by the CDP driver).
- CDP port: 9431. No other benchmark/app instance may use that port/profile.

Copy this `baseline` directory beside `app`, preserving the `scripts` directory
and its sibling scripts. Build the root application with `npm ci` and
`npm run tauri -- build --no-bundle`, using original lockfiles/release profile.
Run [scripts/check-identity.py](scripts/check-identity.py) before measuring to
verify the visible native/page titles and compiled Immich service-name strings;
it does not read or write credential values or establish installer coexistence.
The CDP driver resets
`%APPDATA%\io.github.tursom.RapidRAW\window_state.json` before every launch; its
hardcoded identity must match the built application. Keep the build's source and
executable hashes with the results; do not reuse an older binary after changing
its configuration.

The captured Windows build used the existing task-specific vendored Cargo cache
and verified runtime DLLs because downloads on this host were restricted:

```powershell
$env:CARGO_HOME = 'E:\projects\tbt\rapidraw-baseline\cargo-home'
$env:RAPIDRAW_RUNTIME_DIR = 'E:\projects\tbt\rapidraw-baseline\offline\runtime'
npm run tauri -- build --no-bundle
```

That Cargo home's configuration sets `net.offline=true` and points to sources
prepared with `cargo vendor --locked`. A connected host can obtain the same
locked dependencies normally. Runtime DLLs still undergo the hashes enforced by
`src-tauri/build.rs`; neither vendor contents nor photograph/DLL binaries are
committed with this baseline.

Use Python 3.9+ with `websocket-client`, `pywin32` and Pillow in an **Interactive**
scheduled task in the logged-in desktop session. The existing test interpreter
is `E:\projects\tbt\rapidraw-intake-spike\venv\Scripts\python.exe`; using it does
not authorize changes to intake spike files. SSH Session 0 cannot host the GUI.
Keep the desktop unlocked and unobstructed. Do not touch the mouse/keyboard or
run builds, scans, copies or competing benchmarks during sampling.

Run the two conditions sequentially, then analyze (analysis also runs on Linux):

When reproducing the **old** v3 executable (SHA-256 `26e37ffec105a56210bb6ac8940f742df01c7970224048685b2d811dfe707de6`),
first set `$env:RAPIDRAW_BASELINE_SEED_HEIGHT = '689'` to retain its calibrated
viewport. For the corrected executable, leave that variable unset (720px default).
Do not carry the old compensation into new performance comparisons.

```powershell
python baseline\scripts\check-identity.py
python baseline\scripts\windows-measure.py
python baseline\scripts\windows-measure.py --presets20
python baseline\scripts\analyze.py evidence
```

No other measurement arguments are accepted. Outputs are `measurements.json`
(default) and `presets20.json`, then `summary.json`. The measurement script
**refuses to overwrite** its condition's existing raw file. Before rerunning,
move prior files and any stale summary to an attempts directory in the Windows
workspace outside final `evidence`. Keep old keyboard-contaminated and failed
attempts there, **not in Git**. Never add version fields to rehabilitate old
records. Only final complete v3 raw records and their matching summary are
eligible evidence. A failed analysis does not refresh an existing summary.
Final JSON is normalized to UTF-8/LF and repository formatting without changing
field values. Recomputed summary JSON values must agree; formatter whitespace
need not match the Python output byte for byte. For the v3 rerun, final original
Windows bytes are also retained as deterministic gzip files under `raw/` in the
evidence directory. `raw-provenance.json` records their source-side SHA-256 and
length before transfer; decompression must reproduce those exact bytes and the
same JSON values as the formatted files. These are final successful records,
not archives of failed attempts. Version 2 remains available in commit `2d28f7ea`.

Setup changes only the dedicated generated fixture and this fork's settings:

1. Validates 164 unique manifest paths inside `fixtures` (82 RAW/82 JPEG), sets
   recursive library mode, English labels and grouping off.
2. Writes exposure +0.25 on manifest entries 0–15 through the native metadata
   command. Resets adjustments on all remaining entries to native `null`
   (unedited), including any edits from prior replay/drag runs. Does not invent
   sidecar formats. This intentionally rewrites disposable fixture sidecars.
3. Generates all 164 thumbnails through the real app queue and records each
   generated path. Preparation is outside the measured launch windows.
4. Explicitly configures the default workspace with Adjustments on the right.
   For `--presets20`, saves 20 `task1-*` exposure presets and uses the existing
   configurable workspace to show Presets in `leftBottom` beside Adjustments,
   with left top height 220px. This is fixture configuration. It refuses to
   replace non-fixture presets in the 20-preset condition. Default removes
   `task1-*` presets but retains other presets and reports the actual count.
   After entering the editor, the observer inspects the actual visible English
   Presets heading and mounted draggable cards using current React props. Every
   startup, both ends of switching, and the isolated slider run must record a
   visible panel, exactly 20 unique `task1-00`–`task1-19` cards with matching names
   inside that panel, and at least one visible card. Cards outside the scrolling
   viewport count as mounted only. Settings alone cannot satisfy this check.
   Startup checks occur after the editor-ready timestamp: any extra wait for
   this condition is not included in that readiness metric. Switching starts
   only after the actual panel condition passes.
5. Requires each measured and isolated-drag process to have a 1280×720 CSS
   viewport and DPR 1. The driver's window-state reset compensates for the
   window behavior. The historical v3 binary required a 1280×689 seed because
   its frameless client gained 31px on showing. The independent fix removes
   that discrepancy, so the current seed is 1280×720. The environment override
   above exists only for historical reproduction or explicit host calibration.
   Every seed is written before timing and recorded as `initialWindowState`;
   actual CSS dimensions must still pass the 1280×720 check.

## Samples and timing definitions

Each condition launches a setup process, six fresh startup processes (one
explicit warmup, five measured), and one separate slider process. OS/thumbnail
caches are warm; this is not a cold-boot benchmark. Startup upper bounds use
Python's monotonic clock and include CDP attachment/polling at 20ms.
Before returning a launch to the measurement, the driver requires a visible
Win32 main window belonging to that fresh process and titled `RapidRAW TBT`;
DOM controls rendered while the native window is hidden cannot finish startup.
`nativeVisibleUpperMs` records this visibility boundary separately.

- `landingReadyUpperMs`: launch to Continue Session availability.
- `libraryThumbsUpperMs`: launch through Continue Session to all currently
  viewport-visible thumbnail **containers** having at least one complete `img`
  with positive natural dimensions. Two rAFs must preserve expected/mounted
  counts with zero missing. Ancestor clipping and viewport intersections define
  visibility. Raw `thumbnailCoverage` includes mounted/expected/loaded/missing
  counts and one loaded boolean per expected container; an empty placeholder
  counts as missing, even when another container's image is already loaded.
  Loaded does not mean fully opaque: a loaded library image can still be inside
  its 300ms fade-in. This metric does not wait for that transition to finish.
- `automatedEditorReadyUpperMs`: launch through opening the first library item,
  the editor first-frame marker, and selected-image readiness. Current startup
  requires scripted actions; it does not establish future automatic restore.

Only the sixth startup process supplies switch samples, before any slider edit
or upstream replay. `switchPhase` records its PID, initial path, previously
selected paths, interval, complete observed selection history and input errors.
The script waits for all 164 actual `imageList.is_edited` flags to match setup.
It excludes already-selected paths, then chooses five distinct manifest paths
for each edit/format pair. All twenty first selections precede repeat selections
of the same twenty paths in the same order:

| Edit state | Format | First selection | Repeated selection |
| ---------- | ------ | --------------: | -----------------: |
| Edited     | RAW    |               5 |                  5 |
| Edited     | JPEG   |               5 |                  5 |
| Unedited   | RAW    |               5 |                  5 |
| Unedited   | JPEG   |               5 |                  5 |

There are **40** switches. “First” means first selected in this process, not cold
OS/backend/GPU caches: the normal preloader remains enabled. “Repeated selection”
is a selection-history label only. No backend cache hit is established.

The observer uses current React fiber props to resolve exact full paths for
virtualized thumbnails, filmstrip selection and the image canvas. The driver
reveals a target by scrolling, checks visibility/hit testing, arms that exact
path, and dispatches a trusted CDP mouse click. Capture must resolve the same
path; filenames alone never establish identity. Virtualization recycling,
unexpected selection changes, keyboard input or overlapping clicks fail the
run. This depends on the current React/DOM structure: incompatible builds fail
rather than silently selecting a name-based fallback.

Each raw switch has `start`, `selectedAt`, `readyAt`, `readyPath`, `previewAt`,
`previewPath`, `previewMethod`, `end`, and target/actual/old/final paths:

- `readyAt - start` is **click to usable**, based solely on the matching
  `selectedImage.isReady`. Merely mounting/enabling a range is not readiness.
- `previewAt - start` uses either `svg-decode-raf` (decode a visible SVG source
  matching the current canvas's preview/thumbnail props, then rAF), or
  `wgpu-frame-ready-raf` (path-matched GPU event after click, then rAF with the
  same image still selected). The earlier eligible proxy wins. Async SVG
  completion rechecks the active click, node, href, current canvas props and
  selected path; a callback for an earlier click cannot complete a later one.
  GPU rows retain the corresponding frame timestamp/path. These two proxies
  are reported separately by method within each group, not pooled together.

The proxies do not measure monitor scanout or prove visually correct pixels;
duplicated source photographs further limit visual distinctions. Human visual
verification remains necessary. A `svg-decode-raf` result does not establish
full-image decoding: inspect its `previewHref`. All 32 v2 results were cached
images under `thumbnails/`, matching the intended thumbnail-before-decode flow.
The current report explicitly identifies the v3 sources as well.

After all switches, filmstrip scrolling records 180 real rAF intervals while
moving its real horizontal scroll container by 80px per frame forward/backward.
Every frame records viewport-visible container, loaded and missing counts,
including placeholders. Missing thumbnails are reported, not discarded. Loaded
coverage does not prove absence of compositor flashes.

The unchanged [bench/replay.js](../bench/replay.js) then runs ten cycles (two
warmups/eight measured) as a supplementary smoothness baseline. Its slider
inputs use synthetic DOM mouse events, distinct from the trusted CDP drag below.
Its same-image reopen latency must not be used as the distinct-image preview
baseline. Replay errors/incomplete results reject the condition.

For task 6 and task 13, compare `upstreamReplay.summary.edit.avgFps`,
`worstFrameMs`, `droppedFrameCount` and `droppedFrameTimeMs` (median/P95) between
the same two conditions on this host, alongside switch readiness and scrolling.
These replay values measure main-thread rAF smoothness during synthetic input.
At a roughly 60Hz ceiling, FPS cannot detect a slower preview pipeline that
keeps scheduling frames. The independent trusted drag below verifies input only.
Neither provides an input-to-updated-preview latency baseline; that still needs
a separately validated method before making preview-responsiveness claims.

For task 6/13 comparisons, rerun the preserved baseline executable and the
candidate in the same measurement session with the same scripts, viewport and
display conditions, and record the monitor refresh rate. Select the historical
689px seed for the old executable and the 720px default for the corrected one,
so both actually render at 1280×720. Do not compare a new run directly against
the historical v3 FPS: the unchanged executable already varied between v2/v3.

## Independent slider check

After startup/switch/scroll/replay have finished and their process has stopped,
a fresh process opens the editor, then explicitly selects the first full path
in `fixtureSetup.editedPaths` (the generated `photo-000`), regardless of which
library item opened first. Selection uses the same exact-path reveal/CDP click
guards, outside the timed switch phase. Before dragging, the observer requires
that exact path to be selected, ready and actually marked `is_edited: true`.
It chooses a visible, unobstructed Adjustments slider and dispatches a real CDP
mouse press, 12 held-button mouse moves separated by rAF, and release. It sends
**no direction keys** and does not interleave dragging with timed switches.

`sliderDrag` records its separate PID and startup PIDs, explicit `targetPath`,
`initialEdited`, initial/final selection,
values before/after, pointer coordinates, trusted event sequence, rAF sample
count and any observed path changes. Required assertions are `valueChanged`, `editedTarget`,
`pathUnchanged`, `trustedMouse`, `isolated`, `elementConnected`. The selected
path must remain unchanged throughout observed frames/events and there must be
no switch samples in this process. The analyzer independently requires the
target to be in `editedPaths`; dragging an unedited-group target is rejected even
if its value changes and all asserted flags say success. The drag leaves an edit
only on that already-edited fixture; unedited-group fixtures are not dragged.
The next run's setup resets fixture adjustments. This is a functional check, **not** an
extra latency sample or a measurement of backend processing completion.

## Evidence contract and analysis

Both raw files must have `schema: "rapidraw-task1-baseline"` and integer
`measurementVersion: 3`. `finished` and every required final/sample/drag assertion
must exist and pass; any reported error rejects the file. The analyzer validates
both conditions completely before writing `summary.json`. It rejects older
schemas, legacy keyboard/range/call-array fields, missing readiness or preview
metrics, wrong target ownership, unbalanced groups, incomplete startup/container
counts, unexpected observed selection sequences, missing scroll frames and
non-isolated/untrusted/ineffective slider drags, hidden/missing preset panels or
incorrect mounted-card sets in any required check. It never filters incomplete rows
and presents the remainder as a complete run.

Output has schema `rapidraw-task1-baseline-summary`, version 3,
`conditions["measurements.json"]` and `conditions["presets20.json"]`. Each condition
has `startup` statistics excluding only the first warmup, raw startup thumbnail
counts, and eight `switchesByGroup` entries keyed by `edited`, `kind`, `selection`.
Each group has `n: 5`, `clickToUsableReadyMs` and `previewByMethod` statistics.
Statistics include n, median, nearest-rank p95, min and max; at n=5, p95 is the
maximum, not a robust tail estimate. Slider assertions, filmstrip coverage/frame
statistics and upstream replay summary are separate. No measured results are
supplied by this README or by local synthetic validation.

**Source-file I/O is unknown** (`sourceIO.status: "unknown", traced: false`).
No invoke interception or empty diagnostic call arrays are used. The existing
restore flow enumerates folders/loads EXIF; this protocol does not establish
“cached thumbnails without reading originals.” `backendCache.status` is likewise
`"unknown"`; repeated selection cannot be renamed a backend cache hit.

## Outstanding platform and human work

The committed Windows records establish completion of both v3 conditions,
balanced path-checked samples and independent slider checks. Build, identity,
source/material integrity and remaining acceptance limits are in `BASELINE.md`.
They do not establish human visual correctness. A failed rerun remains a failed
attempt in the Windows workspace; it is not a baseline number.

`windows-window-state.py` is a separate diagnostic. It seeds this fork's window
state once, then launches/closes the same executable three times without any
intermediate reset or injected resize/move. Each launch waits two seconds for
the existing 500ms saver and records native outer/client rectangles, CSS size,
and persisted state before/after native close. It restores the original fork
state afterward. This probe is outside all timing samples; it records the
upstream issue for task placement without changing application behavior.

No Mac host is used by these scripts. macOS still needs a real build/run,
separate fork profile, the same manifest, external-drive coverage, recorded
hardware/OS/renderer/scaling/viewport and cache conditions. Use WebKit inspector,
screen recording or Instruments with documented resolution/actions for its
measurements. Both platforms still require visual slider/preview and white-flash
verification, official-version coexistence and acceptance. Windows results alone
establish neither cross-platform task 1 completion nor stage 1 acceptance.
