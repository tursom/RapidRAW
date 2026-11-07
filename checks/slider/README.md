# Task 2: slider zero snapping

Desktop image-adjustment sliders now snap pointer output to zero within **5 CSS pixels**. The default applies only when the numeric range contains zero and the reset value is zero. `scale.toPosition(0)` determines the target for nonlinear scales. The implementation compares distance in pixels and permits only `1e-9px` of floating-point roundoff at the inclusive boundary; the product threshold remains 5px. Accumulated pointer position continues through the snap band.

Shift and Alt bypass snapping. Text entry, Shift wheel, SpeedEdit and focused range arrow keys use numeric steps without snapping. The existing editor binds arrow keys globally, so desktop range arrows now stop propagation while focused and update by one numeric step; Ctrl/Meta, unfocused editor shortcuts and Android retain their previous paths.

The six caller files contain **20 explicit opt-outs**: Settings 7, Export 4, AI configuration 4, Presets 1, Collage 2 and Culling 2. [The caller audit](evidence/caller-opt-outs.json) verifies that removing only these added props reproduces each base file byte-for-byte. No layout, dependency or backend change is included.

[The quality comparison](evidence/quality/comparison.json) records the unchanged existing source diagnostics: TypeScript **64 → 64** (exit 2), ESLint **835 errors / 45 warnings → the same** (exit 1), with zero additions or removals after normalizing source-root and line/column shifts. The original before/after outputs are preserved as gzip files with raw and archive hashes. This is not a claim that the repository's full checks are green. The modified Slider and browser fixture pass their scoped ESLint and Prettier checks; the [final frontend build](evidence/quality/frontend-build.txt) completed successfully.

This task still needs はく to assess physical dragging feel. macOS and Android devices have not been tested. Stage 1 remains incomplete and Task 10 remains blocked.

## Windows release and real editor checks

The final Windows release build exited **0**. Its 412 source inputs were verified before and after compilation against [source-inputs.json](evidence/windows/source-inputs.json); all match the delivered tree. The build cache's previous source files and original baseline executable were restored afterward. The existing cache needed the already-delivered window fix in `lib.rs` as well as this task's seven TSX files; that eighth copied input is not a new backend change in this task. See [build.json](evidence/windows/build.json) and the [release output](evidence/windows/release.txt). The two readable build-output text files have ANSI color codes and trailing whitespace removed; JSON measurement originals are preserved separately without byte changes.

Final executable on the test machine:

```text
E:\projects\tbt\rapidraw-baseline\app\src-tauri\target\release\RapidRAW-slider.exe
SHA-256 44df8416ee3b1ebe6694221d7ff8d3ee459634c72d05a18ad3e924198ad69967
```

[The real Tauri editor run](evidence/windows/windows-smoke.json) passed **25/25 checks** using WebView2 `Edg/157.0.4341.42`, a 1280×720 CSS viewport and DPR 1. The selected file was a dedicated copy of the baseline NASA RAW, `photo-000.NEF`, not a personal photo. Contrast's actual controlled React value, selected path and trusted input events were checked. The driver reads React state without calling its change callback or changing props.

| Checks                                 | Count | Result                                                                                                |
| -------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------- |
| Track clicks at ±4px and ±8px          |     4 | Inside outputs 0, outside leaves 0                                                                    |
| Shift and Alt track precision          |     2 | Exact +1 and −1 inside the ordinary snap band                                                         |
| Mouse drag both directions and release |     8 | Crosses zero, exits the band, retains output after release                                            |
| Focused range arrows                   |     6 | ±1 steps, focus retained, no key delivered to the editor's window listener, same RAW remains selected |
| Shift wheel                            |     3 | +1, 0, −1                                                                                             |
| Text entry and Enter                   |     2 | Exact +1 and −1                                                                                       |

Each case requires corresponding trusted mouse/key/wheel or text `beforeinput`/`input` events on the intended control. A trusted label click resets the dedicated RAW's Contrast before testing, so a rerun cannot inherit the preceding test's final adjustment. Setup navigation into the RAW uses explicitly synthetic library double-click dispatch and is not presented as a trusted input test. Fine-click coordinates account for WebView2's integer `clientX` rounding; the expected values and 5px threshold are unchanged.

The controller is [windows-smoke.py](windows-smoke.py). It uses the unchanged [baseline CDP driver](../../baseline/scripts/windows-cdp.py) and [observer](../../baseline/scripts/observe.js); their hashes and the controller hash are recorded. To repeat on this prepared test host, copy those two files to `E:\projects\tbt\rapidraw-slider\`, provide the dedicated `fixture\photo-000.NEF` and its [fixture manifest](evidence/windows/fixture.json), copy this controller, and run it with the provisioned Python in an **interactive desktop session**, with all existing RapidRAW TBT windows closed. It refuses to overwrite an existing `evidence\windows-smoke.json`. Use a separate output directory or move the preceding record aside before rerunning. The driver and executable paths are explicit constants, so another host must adapt them rather than accidentally use this machine's profile or fixtures.

```powershell
& 'E:\projects\tbt\rapidraw-intake-spike\venv\Scripts\python.exe' `
  'E:\projects\tbt\rapidraw-slider\windows-smoke.py'
```

The controller temporarily changes only this fork's settings/window-state files, restoring their original bytes in `finally`. Both restoration and the original RAW hash are required for `passed: true` and exit 0. The [final cleanup](evidence/windows/cleanup.json) confirms that the two owned scheduled tasks were removed, no owned application process remains, the RAW hash is unchanged and the original baseline executable is restored. The original baseline evidence was not changed.

[raw-provenance.json](evidence/windows/raw-provenance.json) records the Windows hashes taken **before SCP**, lengths and gzip hashes. `raw/*.gz` preserves each original file, including its original BOM/newlines; readable JSON files are reserialized with identical parsed content. Failed attempts remain outside Git. They exposed three test-harness issues: incomplete workspace settings, fixture edits carried across reruns, and fractional CDP coordinates rounding to the adjacent numeric step. The final run used the corrected controller and final rebuilt executable.

These Windows checks do not measure preview latency, physical touch or human feel. Nonlinear exact ±5px boundaries, touch, nonzero defaults and Android before/after behavior have the separate Chromium component evidence below; they are not described as Windows hardware tests.

## Chromium regression runner

Run from the repository root:

```sh
node checks/slider/run.mjs --output /tmp/slider-result.json
node node_modules/eslint/bin/eslint.js checks/slider/fixture.tsx checks/slider/virtual.d.ts --max-warnings 0
node node_modules/eslint/bin/eslint.js --no-config-lookup \
  --rule 'no-undef:error' --rule 'no-unused-vars:["error",{"ignoreRestSiblings":true}]' \
  --global process --global console --global setTimeout --global URL \
  --global window --global document --global requestAnimationFrame \
  --global HTMLInputElement --global Event \
  checks/slider/run.mjs checks/slider/vite.config.mjs --max-warnings 0
node node_modules/prettier/bin/prettier.cjs --check checks/slider
```

The runner starts its own Vite server on `127.0.0.1:9142`, launches headless Chrome with `--no-sandbox`, and closes both on completion. Their PIDs and shutdown states are in the JSON. An occupied port is an error; the runner does not connect to or stop another server. Without `--output`, results and Vite logs go into a fresh `/tmp/slider-browser-*` directory. Failed runs and experiments belong in `/tmp`; only a final successful run may be copied into `checks/slider/evidence/`.

No dependencies are installed. Defaults use the provisioned tools:

- Playwright: `/root/.npm/_npx/dd48173ecf795e2b/node_modules/playwright/index.mjs`
- Chromium: `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`

Override them with `PLAYWRIGHT_MODULE=/absolute/path/index.mjs` and `CHROMIUM_PATH=/absolute/path/chrome`. `SLIDER_OLD_SOURCE=/absolute/path/Slider.tsx` optionally selects an exact old snapshot; otherwise the control comes from `git show 72dc3ec9:src/components/ui/Slider.tsx`. The runner records SHA-256 for the selected old source, current production Slider, fixture/runner/config and relevant real source dependencies. A production Slider change during the run invalidates the result.

For manual inspection, start only the fixture:

```sh
node node_modules/vite/bin/vite.js --config checks/slider/vite.config.mjs
```

Open `http://127.0.0.1:9142/checks/slider/index.html` for production or append `?old` for the old control. The runner is not used simultaneously with this manual server.

## Actual browser result on the frozen source

Chromium `158.0.8127.18`, production Slider SHA-256 `8f2cd6aad449ac4712fc905c9a4804cc0210b92092f44e6ed9ac0c3c047aef04`, old Slider SHA-256 `17d1394e3ac8b21183a1aec283244ee841ebc2b30c353a583427bec19edc9d4d`: **46 cases passed, 3 old-source negative controls failed as required, and 0 production cases failed**. The runner exited `0` with status `passed`.

The full successful trace is [evidence/chromium.json](evidence/chromium.json). [evidence/frozen-hashes.json](evidence/frozen-hashes.json) records the complete run's source/fixture hashes before and after: all remained identical and matched the runner's provenance. The executable fixture and assertions were unchanged from the run that detected the exact nonlinear 5px boundary failures. The parent session fixed the production comparison; track click at −5px and continuous mouse/touch drag at +5px now emit exactly `0`. Both linear width/range variants, cumulative drags in both directions, fine modifiers, native range suppression probes, precision inputs, reset and all Android before/after comparisons passed.

The runner SHA-256 is `46eba2c3aaff87eb50a2d486bc4b34b5102eb7228ee8c871afd368f78eb59e8d`; fixture TSX SHA-256 is `755c3a2fdab60a18056d07ade18e0aed97b4c5544a0630b677382f0e0e431fa6`. This README's result section was updated after the measured run; the hash record preserves its content at run time. Executable fixture/runner files are frozen. Failed attempts remain only in `/tmp`.

Desktop Windows/macOS range arrows emitted ±1 while retaining focus and producing zero simulated global deliveries. Old-source and Android arrows emitted the native ±1 but lost focus and delivered one global event; Android before/after output/focus/propagation results match. Eleven passive-touch console diagnostics were observed across eleven touch cases, one per case; the old-source control demonstrates the same message and rate. No other console/page error was recorded.

The run's runner PID was `1529184`, Vite PID `1529229`, Chromium PID `1529320`; all exited, and the runner closed both services. No manual cleanup is needed. For an interrupted future run, identify that run's own Vite/Chromium PIDs from its output and terminate those processes. This is a browser result only. Windows/Tauri build and smoke results are owned by the parent session and are not asserted here.

## What is exercised

`fixture.tsx` imports the actual production React `Slider`, actual `useSettingsStore` and actual `useEditorStore`. The fixture supplies controlled React state, two i18n strings and platform state through `useSettingsStore.setState`. `actualstyles.css` imports production `src/styles.css`, including the real 16px thumb, range geometry and active-thumb styling. It supplies only page spacing and theme variables. No Slider implementation or zero-snapping algorithm is copied into this directory.

The test-only Vite plugin loads the exact old Slider source as a virtual TSX module beside the production Slider, so its relative imports resolve to the real production dependencies. It does not write a copied component into `src/` or alter the production Vite config. No Tauri backend, private photo, application initialization or credentials are needed.

| Requirement                                             | Browser coverage                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan 6.8 and §9 first Slider criterion                  | 200px / −100…100 and 400px / −1000…1000; clicks at −6, −5, −4, 0, +4, +5, +6px; continuous mouse/touch paths entering and leaving both sides                                                                                                                                                                                                |
| Cumulative position must continue through the snap band | A single drag crosses and reverses across zero repeatedly; every waypoint checks exact expected output. Resetting accumulation to the snapped output changes subsequent waypoints and fails                                                                                                                                                 |
| Touch activation and end                                | Trusted touch begins near the real thumb; a 4px move emits nothing; a 20px move exceeds the component's 10px threshold and Chromium's own touch slop; subsequent moves and touchend are checked, including delayed default events                                                                                                           |
| Fine adjustment                                         | Shift and Alt independently bypass snapping for track clicks, continuous mouse drags and trusted CDP touch drags, including nonzero values inside the normal snap band                                                                                                                                                                      |
| Native range cannot bypass drag snapping                | All trusted native range input/change events are retained; additional explicitly untrusted range input/change probes inject 42 during active mouse/touch drags and must emit nothing                                                                                                                                                        |
| Plan §9 precision criterion                             | Trusted text input −1/+1, numeric editor Up/Down, focused desktop range all four arrows, Shift wheel −1/+1 and real claimed SpeedEdit target −1/+1                                                                                                                                                                                          |
| Focused desktop range arrows                            | Each key starts at 0, emits exactly the appropriate ±1, retains native focus and never reaches the window's simulated global shortcut listener; Windows and macOS platform state are checked                                                                                                                                                |
| Global key boundaries                                   | Ctrl+ArrowUp and Meta+ArrowDown retain prior blur/global behavior; unfocused Left/Right reach the window listener and do not change Slider                                                                                                                                                                                                  |
| Plan §9 nonlinearity/scope criterion                    | A nonlinear square-root scale maps zero to 1/3 of a 360px track; click/mouse/touch check the same pixel boundaries. Default 50, explicit `snapToZero={false}`, and a positive-only range with explicit true cannot snap                                                                                                                     |
| Reset                                                   | Label click and range double-click reset to defaults 0 and 25; the initial track output before a double-click reset is preserved in the trace                                                                                                                                                                                               |
| Android unchanged                                       | The exact old and new components run identical two-width track, mouse and touch scripts; complete output arrays must match. Text, numeric editor arrows, wheel, SpeedEdit and both reset defaults also compare complete output arrays. Four range arrows, Ctrl/Meta and unfocused global boundaries match the old blur/propagation behavior |

## Trust, intermediate outputs and interpretation

Playwright mouse, keyboard and wheel input and CDP `Input.dispatchTouchEvent` go through Chromium's input system. The fixture asserts that the resulting browser events have `isTrusted=true`. These are automated browser gestures, not physical human input. Chromium can emit a trusted native range `input` during touchstart before the custom drag activates; suppressing its public output is part of the test.

The extra native range probe uses the HTMLInputElement value setter plus `dispatchEvent`. Those two events must have `isTrusted=false`; they complement the trusted gestures and do not replace them. They are injected after two animation frames and verify protection during an established drag, rather than the instant between the initial handler and React state commitment. That startup guard was reviewed in source; no separate instantaneous browser race reproduction is claimed. SpeedEdit claims the real store target via a trusted pointer click, then invokes that target's real `toValue`, `onChange` and drag-state API. Its API calls are explicitly recorded and are not presented as trusted mouse drags or as a full SpeedEdit overlay interaction.

Every production `onChange` is recorded synchronously before React state updates. Each input waypoint has a phase, and every output in that phase must satisfy its assertion. Zero is checked with strict numeric equality. Nonzero expected values allow only floating representation error (`1e-7`), not a whole step. A final correct value cannot hide an earlier wrong emission. Repeated values may be deduplicated by the production component, so an unchanged waypoint does not require a new callback; the controlled value is still checked. No frames or callbacks are removed from saved traces.

The global shortcut simulation is a passive window bubbling listener. It counts delivery without changing focus, value or default behavior. This directly checks the Slider's propagation boundary. The isolated fixture does not mount the full editor hook; it does not claim to test real image navigation or zoom. The old control honestly records all four range arrows blurring and reaching the global listener. In Chromium 158 their native default action still emits ±1 despite the blur; the after desktop path must keep focus and prevent global delivery. The old blur/propagation symptom is not classified as a newly introduced regression.

Old track, mouse and touch snap controls run first and must fail specifically because a nonzero value was emitted where zero is required. Their `expected-failure` statuses establish that the same browser checks detect the original absence of snapping. They are successful negative controls, not production passes. A production assertion failure makes the whole run fail and exit nonzero; independent cases continue so the result includes all observed problems. A source change, unexpected browser console error, unexpectedly passing old control or missing trusted event also fails the run.

Chromium reports `Unable to preventDefault inside passive event listener invocation.` when the existing React touch handler attempts to prevent a passive event. The exact old component produces this diagnostic too. The runner preserves every such console event with implementation/case identity, requires the old control to demonstrate it, and rejects any per-case increase after the change. It does not describe a run with these inherited diagnostics as console-clean.

This is Linux headless Chromium evidence with Windows/macOS/Android store state. It does not replace the parent session's Windows build/WebView2 checks or physical Android testing, and does not mount the settings/export/AI/preset caller panels. Those caller opt-outs require the implementation session's separate source review. No full-repository TS/lint success is claimed by these scoped checks.
