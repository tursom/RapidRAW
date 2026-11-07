"""Validate BOTH complete v2 conditions before writing any summary.

Usage: python analyze.py EVIDENCE_DIR
No Windows dependency. Invalid evidence exits nonzero; never salvage partial
samples or relabel old keyboard measurements by just adding version fields.
"""

from collections import Counter
import json
import math
from pathlib import Path
import statistics
import sys

SCHEMA = "rapidraw-task1-baseline"
VERSION = 2
VIEWPORT = {"width": 1280, "height": 720, "dpr": 1}
SELECTIONS = ("first-selection", "repeated-selection")
SWITCH_ASSERTIONS = ("targetMatched", "selectionStable", "keyboardFree")
DRAG_ASSERTIONS = ("valueChanged", "editedTarget", "pathUnchanged", "trustedMouse", "isolated", "elementConnected")
FINAL_ASSERTIONS = ("switchesComplete", "startupComplete", "isolatedMouseDrag", "keyboardFree", "targetPathsVerified")
LEGACY_FIELDS = {"calls", "observedCalls", "sourceRelatedCalls", "sliderKeyboard", "rangeEnabledAt"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def timestamp(row, key):
    value = row[key]
    require(number(value), f"Invalid timestamp/count: {key}")
    return value


def assertions(row, keys):
    require(isinstance(row.get("assertions"), dict), "Missing assertions")
    require(all(row["assertions"].get(key) is True for key in keys), f"Incomplete assertions: {keys}")


def reject_legacy(value):
    if isinstance(value, dict):
        require(not LEGACY_FIELDS.intersection(value), f"Legacy/keyboard evidence fields: {LEGACY_FIELDS.intersection(value)}")
        for item in value.values():
            reject_legacy(item)
    elif isinstance(value, list):
        for item in value:
            reject_legacy(item)


def stats(values):
    values = sorted(values)
    require(bool(values) and all(number(value) for value in values), "Cannot summarize empty or invalid values")
    return {"n": len(values), "median": statistics.median(values),
            "p95": values[math.ceil(len(values) * 0.95) - 1], "min": values[0], "max": values[-1]}


def validate(data, expected_condition):
    require(data.get("schema") == SCHEMA and type(data.get("measurementVersion")) is int and data["measurementVersion"] == VERSION,
            "Unsupported/missing schema or measurementVersion; remeasure with v2 (old keyboard evidence is invalid)")
    reject_legacy(data)
    require(data.get("condition") == expected_condition, "Wrong condition/file")
    require(bool(data.get("started")) and bool(data.get("finished")) and not data.get("error"), "Unfinished or failed measurement")
    assertions(data, FINAL_ASSERTIONS)
    require(data["sourceIO"] == {"status": "unknown", "traced": False}, "Source IO must explicitly remain unknown")
    require(data["backendCache"]["status"] == "unknown", "No runtime evidence establishes backend cache hits")
    fixture = data["fixtureSetup"]
    entries = fixture["entries"]
    require(fixture["count"] == len(entries) == 164, "Incomplete fixture")
    by_path = {e["path"]: e for e in entries}
    require(len(by_path) == 164 and all(type(e["edited"]) is bool for e in entries), "Invalid fixture paths/edit labels")
    require(Counter(e["kind"] for e in entries) == {"RAW": 82, "JPEG": 82}, "Wrong fixture formats")
    require(set(fixture["editedPaths"]) == {e["path"] for e in entries if e["edited"]} and len(fixture["editedPaths"]) == 16, "Wrong edited fixture set")
    require(set(fixture["generatedThumbnailPaths"]) == set(by_path) and len(fixture["generatedThumbnailPaths"]) == 164, "Incomplete generated thumbnails")
    preset_count = data["presetLibrary"]["count"]
    require(type(preset_count) is int and preset_count >= 0 and (expected_condition != "presets20" or preset_count == 20), "Wrong preset count")
    startup = data["startup"]
    require(len(startup) == 6, "Expected one warmup and five startup measurements")
    for index, row in enumerate(startup):
        require(row["index"] == index and row["warmup"] is (index == 0), "Wrong startup order/warmup")
        require(row["page"]["viewport"] == VIEWPORT, "Uncontrolled startup viewport")
        times = [timestamp(row, key) for key in ("nativeVisibleUpperMs", "landingReadyUpperMs", "libraryThumbsUpperMs", "automatedEditorReadyUpperMs")]
        require(0 < times[0] <= times[1] <= times[2] <= times[3], "Invalid startup timings")
        coverage = row["thumbnailCoverage"]
        require(type(coverage["expected"]) is int and 0 < coverage["expected"] <= coverage["mounted"] <= 164,
                "Missing expected thumbnail containers")
        require(coverage["loaded"] == coverage["expected"] and coverage["missing"] == 0, "Incomplete thumbnail containers")
        require(len(coverage["items"]) == coverage["expected"] and all(e.get("loaded") is True for e in coverage["items"]), "Missing per-container loaded evidence")
        require(row["status"]["imageCount"] == 164 and row["status"]["selected"]["isReady"] is True and row["status"]["selected"]["path"] in by_path,
                "Incomplete startup editor selection")
        require(type(row["pid"]) is int and row["pid"] > 0, "Missing startup process identity")
    phase = data["switchPhase"]
    require(phase["pid"] == startup[-1]["pid"] and phase["initialPath"] == startup[-1]["status"]["selected"]["path"], "Wrong switch process/initial path")
    require(phase["errors"] == [] and phase["keyboardEvents"] == 0, "Switches contain observer errors/keyboard input")
    require(timestamp(phase, "start") < timestamp(phase, "end"), "Invalid switch phase interval")
    history = phase["selectionHistory"]
    require(history and all(e["path"] in by_path and number(e["at"]) for e in history), "Missing selection history")
    require(all(a["at"] <= b["at"] for a, b in zip(history, history[1:])), "Unordered selection history")
    seen = set(phase["seenPaths"])
    require(seen == {e["path"] for e in history if e["at"] <= phase["start"]} and phase["initialPath"] in seen, "First-selection history is incomplete")
    rows, plan = data["switches"], data["switchPlan"]
    require(len(rows) == len(plan) == 16, "Expected 16 switches, including eight first and eight repeated selections")
    cells = Counter()
    previous, previous_end = phase["initialPath"], phase["start"]
    first_paths, repeated_paths = [], []
    for index, (row, planned) in enumerate(zip(rows, plan)):
        assertions(row, SWITCH_ASSERTIONS)
        require(row["index"] == index and all(row[key] == planned[key] for key in ("targetPath", "edited", "kind", "selection")), "Click does not match sample plan")
        path = row["targetPath"]
        require(path in by_path and type(row["edited"]) is bool and row["edited"] == by_path[path]["edited"] and row["kind"] == by_path[path]["kind"], "Wrong target edit/format labels")
        require(row["actualPath"] == row["finalPath"] == row["readyPath"] == row["previewPath"] == path, "Wrong click/readiness/preview path ownership")
        require(row["oldPath"] == previous and previous != path, "Click was not a distinct-image switch")
        start, end = timestamp(row, "start"), timestamp(row, "end")
        require(previous_end <= start < end <= phase["end"], "Overlapping/out-of-phase click samples")
        selected, ready, preview = (timestamp(row, key) for key in ("selectedAt", "readyAt", "previewAt"))
        require(start <= selected <= ready <= end and selected <= preview <= end, "Incomplete/out-of-interval ready or preview timestamp")
        sequence = [e["path"] for e in history if start <= e["at"] <= end]
        require(path in sequence and all(p in (previous, path) for p in sequence), "Selection history does not establish target ownership")
        if previous in sequence:
            require(sequence.index(previous) < sequence.index(path), "Selection reverted during sample")
        method = row["previewMethod"]
        require(method in ("svg-decode-raf", "wgpu-frame-ready-raf"), "Unknown preview method")
        require(isinstance(row["gpuFrames"], list) and all(number(f["at"]) and start <= f["at"] <= end and f["path"] in by_path for f in row["gpuFrames"]), "Invalid GPU diagnostics")
        if method == "svg-decode-raf":
            require(isinstance(row["previewHref"], str) and bool(row["previewHref"]), "Missing SVG preview source")
        else:
            require(start <= timestamp(row, "gpuFrameAt") <= preview and any(f["path"] == path and f["at"] == row["gpuFrameAt"] for f in row["gpuFrames"]), "Missing path-matched GPU frame")
        expected_selection = SELECTIONS[index // 8]
        require(row["selection"] == expected_selection, "First/repeated selection phases interleaved")
        require((path not in seen) if expected_selection == "first-selection" else (path in first_paths), "False first/repeated selection label")
        (first_paths if expected_selection == "first-selection" else repeated_paths).append(path)
        seen.add(path)
        cells[(row["edited"], row["kind"], row["selection"])] += 1
        previous, previous_end = path, end
    require(len(set(first_paths)) == 8 and repeated_paths == first_paths, "Wrong distinct/repeated paths")
    require(cells == Counter({(edited, kind, selection): 2 for edited in (True, False) for kind in ("RAW", "JPEG") for selection in SELECTIONS}), "Unbalanced edit/format/selection cells")
    require([e["path"] for e in history if phase["start"] < e["at"] <= phase["end"]] == [r["targetPath"] for r in rows], "Unexpected selection outside/between click samples")
    scroll = data["filmstripScroll"]
    frames = scroll["frames"]
    require(len(frames) == 180 and scroll["scrollWidth"] > scroll["width"] > 0 and previous_end <= timestamp(scroll, "start") < timestamp(scroll, "end"), "Incomplete/no-op filmstrip scroll")
    last_at = scroll["start"]
    for frame in frames:
        require(number(frame["at"]) and last_at < frame["at"] <= scroll["end"] and number(frame["deltaMs"]) and frame["deltaMs"] > 0 and math.isclose(frame["deltaMs"], frame["at"] - last_at, abs_tol=0.01), "Invalid scroll frame interval")
        require(all(type(frame[k]) is int and frame[k] >= 0 for k in ("visible", "loaded", "missing")) and frame["visible"] > 0 and frame["loaded"] + frame["missing"] == frame["visible"], "Incomplete scroll thumbnail counts")
        require(number(frame["scrollLeft"]), "Invalid scroll position")
        last_at = frame["at"]
    require(max(f["scrollLeft"] for f in frames) > 0, "Filmstrip did not scroll")
    drag = data["sliderDrag"]
    assertions(drag, DRAG_ASSERTIONS)
    require(drag["targetPath"] in fixture["editedPaths"] and drag["initialPath"] == drag["targetPath"] and drag["initialEdited"] is True,
            "Slider drag must explicitly target an editedPaths member; unedited-group fixtures must not be edited")
    require(drag["inputMethod"] == "CDP Input.dispatchMouseEvent" and drag["switchSamplesInProcess"] == 0 and drag["pathChanges"] == [] and drag["samples"] >= 12, "Drag not independently observed")
    require(drag["initialPath"] == drag["finalPath"] and drag["initialPath"] in by_path and drag["before"] != drag["after"], "Slider did not change value on the same fixture image")
    require(all(math.isfinite(float(drag[k])) for k in ("before", "after")), "Invalid slider values")
    require(drag["pid"] not in [r["pid"] for r in startup] and drag["startupPids"] == [r["pid"] for r in startup] and drag["page"]["viewport"] == VIEWPORT, "Slider not in separate controlled process")
    require(timestamp(drag, "start") < timestamp(drag, "end"), "Invalid drag interval")
    events = drag["trustedEvents"]
    require(events and all(e["trusted"] is True and drag["start"] <= timestamp(e, "at") <= drag["end"] for e in events), "Untrusted/out-of-interval slider events")
    types = [e["type"] for e in events]
    require(types[0] == "mousedown" and types[-1] == "mouseup" and types.count("mousedown") == types.count("mouseup") == 1 and types.count("mousemove") >= 12, "Missing real mouse drag sequence")
    require(all(a["at"] <= b["at"] for a, b in zip(events, events[1:])), "Unordered mouse events")
    require(number(drag["points"]["x"]) and number(drag["points"]["endX"]) and drag["points"]["x"] != drag["points"]["endX"], "No mouse displacement")
    replay = data["upstreamReplay"]
    require(data["upstreamReplayErrors"] == [] and replay["config"] == {"iterations": 10, "warmupIterations": 2}, "Supplementary replay incomplete or failed")
    require(len(replay["iterations"]) == 10 and all(r["index"] == i and r["warmup"] is (i < 2) for i, r in enumerate(replay["iterations"])) and replay["summary"], "Incomplete upstream replay iterations")


def click_stats(rows):
    return {"n": len(rows), "clickToUsableReadyMs": stats([r["readyAt"] - r["start"] for r in rows]),
            "previewByMethod": {method: stats([r["previewAt"] - r["start"] for r in rows if r["previewMethod"] == method])
                                for method in sorted({r["previewMethod"] for r in rows})}}


def summarize(data):
    startup = data["startup"][1:]
    rows, frames = data["switches"], data["filmstripScroll"]["frames"]
    return {
        "condition": data["condition"], "finished": data["finished"], "presetCount": data["presetLibrary"]["count"],
        "sourceIO": data["sourceIO"], "backendCache": data["backendCache"],
        "viewports": [r["page"]["viewport"] for r in data["startup"]],
        "imageCounts": [r["status"]["imageCount"] for r in data["startup"]],
        "startupThumbnailCounts": [{k: r["thumbnailCoverage"][k] for k in ("mounted", "expected", "loaded", "missing")} for r in data["startup"]],
        "thumbnailPathsGenerated": len(data["fixtureSetup"]["generatedThumbnailPaths"]),
        "startup": {key: stats([r[key] for r in startup]) for key in ("nativeVisibleUpperMs", "landingReadyUpperMs", "libraryThumbsUpperMs", "automatedEditorReadyUpperMs")},
        "switchesByGroup": [{"edited": edited, "kind": kind, "selection": selection,
                             **click_stats([r for r in rows if r["edited"] == edited and r["kind"] == kind and r["selection"] == selection])}
                            for edited in (True, False) for kind in ("RAW", "JPEG") for selection in SELECTIONS],
        "sliderDrag": {"assertions": data["sliderDrag"]["assertions"], "before": data["sliderDrag"]["before"],
                       "after": data["sliderDrag"]["after"], "path": data["sliderDrag"]["initialPath"],
                       "note": "Separate process functional check; not a click-to-ready latency sample"},
        "filmstrip": {"frames": len(frames), "frameIntervalMs": stats([r["deltaMs"] for r in frames]),
                      "averageFps": 1000 / statistics.mean(r["deltaMs"] for r in frames),
                      "framesWithMissingLoadedThumbs": sum(r["missing"] > 0 for r in frames),
                      "maxMissingThumbs": max(r["missing"] for r in frames), "maxScrollLeft": max(r["scrollLeft"] for r in frames)},
        "upstreamReplay": data["upstreamReplay"]["summary"],
    }


def main(argv):
    if len(argv) != 1:
        raise SystemExit("Usage: python analyze.py EVIDENCE_DIR")
    root = Path(argv[0])
    output = {"schema": SCHEMA + "-summary", "measurementVersion": VERSION,
              "units": "milliseconds unless stated", "p95": "nearest rank", "conditions": {}}
    # Validate both in full before computing/writing; a failure never emits a
    # partial summary. Existing summaries are not evidence for a failed rerun.
    try:
        records = []
        for filename, condition in (("measurements.json", "default"), ("presets20.json", "presets20")):
            try:
                data = json.loads((root / filename).read_text(encoding="utf-8-sig"))
                validate(data, condition)
            except (KeyError, TypeError, ValueError, OverflowError) as error:
                raise ValueError(f"{filename}: {error}") from error
            records.append((filename, data))
        for filename, data in records:
            output["conditions"][filename] = summarize(data)
    except (OSError, ValueError) as error:
        raise SystemExit(f"Evidence rejected; no summary written: {error}") from error
    (root / "summary.json").write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
