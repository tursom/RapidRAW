# Task 5 browser fixture

This fixture runs current production front-end code in Linux headless Chromium.
The native host, image metadata/decode and model results are explicit local mocks.
There is no model execution, download, native generation or native filesystem save.
Windows application evidence and the overall README belong to the parent sessions.

The eight-source frozen suite retains the preceding 70 groups and strengthens
the existing group 71 CSS paint regression with semantic Cancel text and contrast
assertions. Totals stay 71 groups, 727 steps and 467 trusted steps: the preceding
groups retain 689 steps and 455 trusted steps, and group 71 has 38 steps and 12
trusted steps. Publication requires the parent's matching eight-source freeze
and a complete successful final run. Partial development reports stay under
`/tmp`. Completed publication counts, source hashes and quality results belong to
[browser-manifest.json](evidence/browser/browser-manifest.json) and the immutable
[chromium.json.gz](evidence/browser/chromium.json.gz).

The parent freeze includes SidePanelArea
`ac9a543a95bfe39d5dccdd23de9dece7aaf86bc74e0a8e0c1ba59472c1be1bb3`
and the seven other sources, including AI masking
`7927b13915be9f81adb898f7be1d4910f95b8351a19e536ba2d5521a1ee9b407`.
The actionbar is frozen at
`c0bb3f49adbb2c8ecab376e59c22c3195d0161b218ed61b48f7afab357ec5eae`.
The parent added only Cancel's semantic `text-text-primary` class after the
preceding ring-layer fix. The earlier reverse proof in
`/tmp/tbt-sessions-group71-reverse-proof.json` preserves the original 70-group
runner/fixture file hashes.
The controller remains
`f63dce3716862e824cb0a2713e31ab5083dcb9e0c3e2d05d0c711afbd3d29cf1`,
98,791 bytes. All 417 application inputs, eight frozen sources and 430 runtime
paths are checked before and after execution. The browser suite does not execute
Windows or an AI model. Original busy, focused-input and orphan assertions remain
unchanged, and the native supplement still derives its 14 rows from the same
63 original source records. The orphan group uses a unique persisted loading ID,
no request/task, deferred mock cancel IPC and real production buttons.

Preceding successful seven-source artifacts are preserved outside the repository
under `/tmp/superseded/`; failed diagnostics remain in their original temporary
locations. Only the latest successful gzip, manifest and supplement are published
in the repository.

## Running

Run from `RapidRAW/` using the already installed tools:

```sh
node checks/tool-sessions/run.mjs --dev --case 'busy '
node checks/tool-sessions/run.mjs --dev --case 'A to B'
node checks/tool-sessions/run.mjs --dev --case 'AI prompt focused'
node checks/tool-sessions/run.mjs --dev --case native-supplement
```

`--dev` writes uncompressed diagnostic JSON and failure screenshots only under
`/tmp/tool-sessions-browser-*`. A case filter is a substring; use
`TOOL_SESSIONS_CASE` or `--case`. Partial reports explicitly list missing native
supplement rows and cannot publish final evidence.
The reserved `native-supplement` subset runs the actual busy/loading/prompt
cases required by the native validator in one development report; it still is
not a frozen full-suite result and publishes no artifacts.
Add `--quality` to collect default ESLint and complete imported-graph TypeScript
diagnostics in a development report. The frozen run always collects them;
focused development reruns do not repeatedly typecheck unrelated imports.

The final run requires the parent's explicit production freeze:

```sh
node checks/tool-sessions/run.mjs --parent-frozen --freeze /tmp/tbt-sessions-source-freeze.json --inputs /tmp/tbt-sessions-inputs.json
```

The parent manifest contains `files: [{path, sha256}]`, including editor actions,
AI masking, keyboard, UI/editor stores, `ToolSessionActions.tsx`, `Editor.tsx`
and `SidePanelArea.tsx`.
Every supplied hash must match. `--output` can name a new `.json.gz` path.
The matching parent build-input manifest is also required; all of its files are
included in both runtime hash snapshots. Publication requires a complete,
successful run, matching parent manifests, identical pre/post source
maps, retained trusted input for every trusted step, and successful cleanup.
Existing artifacts are never overwritten. A failed run leaves diagnostics in
`/tmp`, not a passing repository artifact. The published gzip, its native
supplement and manifest were created only after that gate. Repeat verification
can use `--dev --quality`; frozen publication refuses to overwrite any of the
three existing evidence files.

Defaults are Playwright
`/root/.npm/_npx/dd48173ecf795e2b/node_modules/playwright/index.mjs`, Chromium
`/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`, and Vite
`127.0.0.1:9145`. Override with `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH` and
`TOOL_SESSIONS_PORT`. No dependencies are installed. Browser requests outside the
local fixture origin are blocked and fail the run. HMR is disabled so concurrent
development cannot silently replace the mounted hook implementation; any source
drift still fails the pre/post hash comparison.

## Production code and explicit fixture boundaries

The fixture imports real `useUIStore`, `useEditorStore`, `useProcessStore`,
settings/library stores, `useEditorActions`, `useKeyboardShortcuts`,
`ToolSessionActions`, `Button`, `Slider`, `CurvesPanel`, `useAppNavigation`,
`useImageLoader` and `useAiMasking`. It uses production CSS, dark theme tokens,
the production English resource and `ContextMenuProvider`.

Mode controls are labelled fixture buttons that call production store routing.
The tool mutation control uses production `setAdjustments` to alter deterministic
crop geometry, mask data or AI patch data. This is a tool-session state test: it
does not mount the actual Crop/Masks/AI panels, draw a brush stroke, move a crop
handle, generate a patch, or prove their full usability. Prompt/rename/editable
elements are labelled input sentinels for the real global keyboard hook, rather
than the actual tool-panel input widgets.

The production Apply/Cancel buttons are mounted directly. Their selectors are
`[data-tool-session-actions]` and `[data-tool-session-action="apply"|"cancel"]`.
The test checks real button state, English labels from `modals.transform`, native
focus/Enter behavior and `bg-surface` on Cancel. Both `!isReady` and busy inputs
must disable them. Clearing busy must re-enable them without a remount.

Navigation uses the real hooks, the real `globalImageCache` and mock deferred
`load_metadata` IPC. Cached navigation first installs cached B data and then
rebases to different fresh metadata. Cold navigation waits on metadata before
the mock image becomes ready. Snapshot assertions and cancellation use B's
baseline; A's applied edits are checked in the actual cache. The separate
A→B→cached-A direct-patch test holds returning A metadata so a fresh load cannot
hide an abandoned `isLoading` value in the frontend cache.

`host.ts` throws for unknown IPC and records every configured call and argument.
The real subject-mask/direct-patch hook can invoke only deferred mock commands.
Completing those promises tests real task registration, result ownership and
cleanup. Same-image completion is a positive control. Different-image and
same-path `resetHistory` completion must not alter the replacement owner or its
history. Reused submask IDs deliberately challenge ownership checks. The broader
busy matrix sets flags/container loading/process tasks programmatically and is
labelled as such. None of these cases certify native AI generation or model
quality, provider authentication, actual cancellation of a native worker, or
network operation.

Three additional direct-patch cases establish an AI session snapshot while the
real hook has a pending loading state: switching tools and reentering AI,
same-path `resetHistory` of the live pending state, and returning to cached A
before its request completes. The snapshot must retain content with
`isLoading=false`. Once the real hook's mocked request settles, Cancel must keep
loading false, Undo must recover cancelled content, and Redo must restore the
clean cancellation result. Returning-A metadata remains held during those
assertions, so neither a fixture rewrite nor a later metadata refresh can repair
the snapshot on behalf of production.

The new legacy-orphan group runs first after module initialization. Programmatic
metadata setup uses a unique patch/submask ID with `isLoading=true`, without
calling a generation hook or registering a task. It checks that both production
buttons are disabled and that no generation IPC or task exists. A trusted click
invokes the real `handleCancelAiTask`; only its cancel IPC is explicitly deferred
and resolved by the host mock. Buttons must remain disabled before that mock
settles, then the real hook must clear loading and re-enable both buttons without
a fixture clear-flag call. Trusted edits and actual Apply/Cancel clicks verify
both exit paths, including Undo/Redo for Cancel. This is a local front-end recovery
check and does not certify cancellation of a native worker. Production hook owner
success/failure and request-slot races are covered separately by the parent's
AI controls.

## Assertions and input evidence

Each of Crop/Masks/AI exercises:

- Cancel restores only the tool's own fields while preserving real global Slider
  and Curve edits; Undo restores the cancelled content and Redo restores Cancel.
- A pending production history debounce is present immediately before Cancel;
  immediate Undo and a wait beyond 500ms detect a late history overwrite.
- Apply, Enter and NumpadEnter keep edits and exit. Switching tools keeps edits;
  cancelling the next tool preserves the earlier tool's applied content.
- Trusted click/Tab/Tab/Enter focuses Cancel and performs Cancel, with no
  programmatic focus in the measured input sequence.
- Textarea, text input and contenteditable Enter/Escape leave the tool active.
  Straighten, submask and container Escape layers exit before outer cancellation.
- Independent `isGeneratingAi`, `isGeneratingAiMask`, mask-container loading,
  AI-patch loading and a nonselected `activeAiTasks` ID disable both buttons,
  Enter and outer Escape. Direct action guard observations are labelled API
  checks. No flags are invented as native-generation evidence.
- Cached/cold A→B rebases rebuild snapshots before B can be cancelled.

Android browser configuration has no new actions and preserves the old Crop
Enter/Escape and Masks/AI Enter/external-back behavior. This is a platform branch
check, not Android hardware testing.

Input comes from Playwright/CDP. Host capture observers record `isTrusted`, event
type, target/tag, key/code, coordinates and input values. Each step retains its
own before/after and raw trace slice. Trace buffers are never cleared between
steps. A trusted step fails without an actual trusted event of the declared
type in its own phase; the runner independently checks retained coverage at the
end. Fixture setup, mock completion, direct action calls and state observations
have separate step types and are not counted as user input.

The prompt supplement additionally measures real shared `applyToolSession`
calls using V8 precise coverage. An explicitly labelled busy/API setup first
calibrates a positive call. The next coverage interval includes trusted prompt
input and Enter and must observe zero shared Apply calls in the same script.
V8 can omit a function with no new executions after a counter reset: its empty
raw result is retained together with the positive calibration, rather than
adding a fabricated zero-count function record.

## Rapid SidePanelArea lifecycle regression

Group 70 mounts actual `SidePanelArea`, `PanelSwitcher`, Motion,
UI/editor stores, keyboard and `ToolSessionActions` inside the existing mocked
host. Panel bodies are explicitly labelled placeholders with real DOM headings
and independently numbered component instances; no production tool internals or
canvas are claimed. It exercises Crop/Masks/AI × Apply/Cancel × 50/100/150/180/250ms
× two repetitions, using actual production action buttons and tabs.

Each trial first establishes a fully visible initial tool pane. The measured
sequence then clicks Apply/Cancel and returns at the requested boundary without
an animation or Playwright actionability wait. Raw CDP commands, hit geometry,
trusted clicks and actual click intervals are retained. When the moving native
tab indicator completely covers a target, trusted Tab traversal and native Enter
activate that same button; this input variation and its timing are recorded.
No callback invocation or programmatic focus substitutes for browser input.

After two frames, assertions require the store, outer region, real current-root
AnimatePresence key, current child key and sole connected heading to match the
tool. The old content instance must have unmounted and a new instance mounted.
An unconditional 200ms observation follows those immediate assertions and checks
full visibility; it never retries or delays a failed re-entry assertion.

Before the production fix, an independent temporary ordinary rapid-click matrix
in `/tmp/tbt-sidepanel-repro-8pMyZ8/summary.json` reproduced four persistent wrong
headings in 20 rows: Masks and AI, both Apply and Cancel, around 167–178ms actual
return timing. They remained wrong for over six seconds, despite the outer
region and store already selecting the tool. Fourteen rows were normal and two
never entered the requested tool, so those two are excluded from the lifecycle
failure count. That temporary fixture used the original SidePanelArea hash
`aedccbe50ec41e3757f2e957aff6b7e470862b44c0cfd99eb10596fa8f49fac1`,
matching `fbb76a9f`. Raw frames, DOM, mounts, commands and screenshots are retained
there. The parent reviewer's controlled Motion hook evidence under
`/tmp/tbt-task5-panel-review/` is a separate scope; this browser group does not
claim to reproduce its internal scheduler controls or native attempt4.

## Minimal Editor CSS paint regression

Group 71 mounts real `ToolSessionActions` and production CSS with a minimal flex
viewport and labelled toolbar/viewport placeholders. The runner parses the
actual `Editor.tsx` class expressions using TypeScript, resolves the nonfullscreen,
instant-transition, preferred-but-inactive WGPU branch, and retains the original
expressions, chosen inputs and resolved classes. No full Editor, ImageCanvas,
canvas element or WGPU renderer is mounted.

For Crop/Masks/AI and both Apply/Cancel, it compares an explicit exact historical
wrapper class override (`shrink-0 flex justify-center gap-3 py-2`) with the untouched
current production wrapper. The override is marked programmatic setup and
identifies the historical component SHA; buttons, handlers, stores and CSS stay
production. Each screenshot is retained as original PNG base64, bytes and SHA in
the raw step, along with DOM geometry and computed styles.

The old static control must yield exactly one RGB color across each entire button
box: the actual viewport ring fill. The current production row must contain both
button background and text pixels, have `position: relative; z-index: 10`, and
preserve exactly the same button/actionbar/viewport geometry. Both variants must
remain hit-testable and accept trusted actual Apply and Cancel clicks that exit
to Presets without changing the unedited adjustments. All twelve screenshot rows
and twelve trusted action steps are retained. Every old static row uses the
production dark theme, preserving the ring's RGB(35,35,35) negative control.
Production Apply rows cover all three tools in dark; production Cancel rows use
dark/light/grey as minimal semantic-color controls. All colors come from the
production `THEMES` variables, with no product RGB values supplied by the fixture.

For every production screenshot, Cancel's actual computed foreground must match
the browser-resolved `--color-text-primary` token and the generated
`text-text-primary` utility. A transparent-parent probe ensures that utility
resolution cannot pass through inherited body text color. The actual foreground
and background must meet 4.5:1 text contrast, and the PNG must contain foreground
label pixels in addition to button fill pixels. Geometry comparisons still use
the same exact rectangles. This strengthens the existing group without changing
its step or trusted-input counts or any preceding group assertions.

PNG decoding uses only Node's
built-in zlib and buffers, with no image library dependency or application-canvas
readback. These assertions prove minimal CSS paint behavior, not full Editor,
Windows screenshots, image alignment or a native/WGPU backend.

The earlier CPU CSS proof remains in
`/tmp/tbt-actionbar-ring-repro-tebo2h6v/`. Its explicit `archive-whitelist.json`
binds 26 payload files: raw/report, fixture and runner sources, HTML/CSS, original
and control PNGs, and four byte-matched production source snapshots. Packaging
uses only those exact files plus the whitelist itself; it excludes caches,
logs, bundles and every unlisted path. `archive-files.txt` is an optional packaging
helper, not an evidence payload. That proof also removes the ring independently
and restores original classes, with pixel-identical original/restored screenshots.

## Geometry, baseline controls and native supplement

At 1280×720 and 800×600 the actual action container must be below the fixture
canvas boundary, have visible/hittable buttons, stay inside the viewport and
use normal layout rather than absolute/fixed positioning. A read-only TypeScript
AST check verifies the real `Editor.tsx` mounts `ToolSessionActions` as the next
flex-column sibling after the viewport containing `ImageCanvas`.
**This is focused source/DOM proof; full Editor/ImageCanvas, crop projection,
alignment and rendered photo pixels are not mounted or certified here.**

`git show fbb76a9f` supplies exact Task 4 actions and keyboard source through Vite
virtual modules, without writing to production. Focused negative controls reject
the old Masks Enter behavior and old immediate crop-cancellation Undo behavior
using the same outcome assertions. They use current imported stores and
dependencies and do not represent a complete historical application build.

`supplement.mjs` derives `nativeSupplement` from the same retained observations.
The 14 required names match the native controller's `BROWSER_REQUIRED`: 12
`busy-{crop|masks|ai}-{isGeneratingAi|isGeneratingAiMask|container-isLoading|activeAiTasks}`
rows, `new-image-not-ready` and `ai-prompt-enter`. Each row includes
`notnativegeneration` at the supplement root, the canonical setup, computed
assertions, unchanged trusted input records, and the exact source steps with
case/step indices and serialized-record SHA-256. Both container-loading variants
are retained under the canonical container flag. Missing or failed observations
cannot produce a passing row; a final publication requires all 14 rows.

The final [native-supplement.json](evidence/browser/native-supplement.json) is an
exact serialization of the `nativeSupplement` object inside the final raw browser
report. All 14 named cases passed. Every excerpt was checked against its original
step and digest, and every Enter has trusted keydown/keyup. The browser manifest
hashes both artifacts. The parent can stage this JSON and bind its
path/bytes/SHA-256 to the Windows controller and EXE in `browser-coverage.json`.
The current native validator can also consume the complete gzip directly. The
browser's pre/post input maps therefore bind the exact `windows-smoke.py` bytes
as a read-only provenance input. Changing that controller during a frozen run
fails the source consistency check just like changing a browser runtime input.
This child never modifies the controller, its validator, native report or EXE.

## Quality and development results

```sh
./node_modules/.bin/eslint checks/tool-sessions/{fixture.tsx,host.ts,bootstrap.ts,virtual.d.ts} --max-warnings 0
./node_modules/.bin/tsc -p checks/tool-sessions/tsconfig.browser.json
./node_modules/.bin/prettier --check checks/tool-sessions/{fixture.tsx,host.ts,bootstrap.ts,virtual.d.ts,fixture.css,vite.config.mjs,run.mjs,supplement.mjs,index.html,tsconfig.browser.json,browser.md}
```

The frozen run records default TypeScript ESLint **0 errors / 0 warnings** and
Prettier exit 0, without disables or configuration exceptions. Fixture TypeScript
uses real production types and has **0 own diagnostics**. The imported production
graph has **22 diagnostics**, including the newly imported PanelSwitcher i18n
key diagnostic, retained verbatim in the raw report; this is not a
clean whole-graph TypeScript result. Node syntax checks also passed for the runner,
supplement extractor and Vite configuration.

The complete run covers real Slider/Curve cancellation and history, busy guards,
focus/input handling, all six cached/cold transitions, the real deferred AI hook
owner cases, all three pending snapshot boundaries, DOM geometry and Task 4
negative controls. Cleanup cancelled fixture debounces, settled mock requests,
closed Chromium/Vite and verified Vite's PID and port were gone.

Development attempts and the first frozen attempt remain under `/tmp`. The first
frozen attempt passed its cases but was correctly rejected for a runner hash
change while adding the native validator's new controller binding. It produced
no final artifacts. The published run has no source drift, failed cases, failed
steps or browser/host errors. Its raw gzip is unchanged by documentation and
manifest self-check updates. Windows/native generation, hardware and complete
canvas rendering retain the limitations stated above.
