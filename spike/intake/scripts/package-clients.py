"""Package the independent intake probes on native Windows/macOS CI runners."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile


PROJECT = Path(__file__).resolve().parents[1]
REPOSITORY = PROJECT.parents[1]
TARGETS = {
    "x86_64-pc-windows-msvc": ("win32", "windows-x64"),
    "aarch64-apple-darwin": ("darwin", "macos-arm64"),
    "x86_64-apple-darwin": ("darwin", "macos-x64"),
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, cwd=PROJECT):
    print("Running: " + subprocess.list2cmdline([str(x) for x in command]), flush=True)
    subprocess.run([str(x) for x in command], cwd=cwd, check=True)


def version(command):
    return subprocess.check_output(command, cwd=PROJECT, text=True).strip()


def configuration(mode, macos):
    base = json.loads((PROJECT / "src-tauri/tauri.conf.json").read_text())
    override = (
        json.loads((PROJECT / "src-tauri/tauri.html5.conf.json").read_text())
        if mode == "html5"
        else {}
    )
    window = dict(override.get("app", {}).get("windows", base["app"]["windows"])[0])
    if window["dragDropEnabled"] != (mode == "native"):
        raise RuntimeError("Source configuration has unexpected drag/drop mode")
    name = "RapidRAW Intake " + ("Native" if mode == "native" else "HTML5")
    window["title"] = name
    bundle = {"active": macos}
    if macos:
        bundle.update(
            icon=[str(REPOSITORY / "src-tauri/icons/128x128.png"), str(REPOSITORY / "src-tauri/icons/icon.icns")],
            macOS={"signingIdentity": "-"},
        )
    return {
        "productName": name,
        "identifier": base["identifier"] + "." + mode,
        "app": {"windows": [window]},
        "bundle": bundle,
    }


def file_records(directory):
    records = []
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory).as_posix()
        if path.is_symlink():
            records.append({"path": relative, "symlink": os.readlink(path)})
        elif path.is_file():
            records.append({"path": relative, "bytes": path.stat().st_size, "sha256": sha(path)})
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=TARGETS)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    expected_os, label = TARGETS[args.target]
    if sys.platform != expected_os:
        parser.error("Build on a native runner for " + args.target)
    output = args.output.resolve()
    if output.exists():
        parser.error("Output already exists; refusing to overwrite artifacts")
    output.mkdir(parents=True)
    stage = output / ("rapidraw-intake-" + label)
    stage.mkdir()
    macos = sys.platform == "darwin"
    npm = ["npm"] if macos else ["cmd.exe", "/d", "/c", "npm.cmd"]
    locks = [PROJECT / "package-lock.json", PROJECT / "src-tauri/Cargo.lock"]
    before = {p.name: sha(p) for p in locks}
    metadata = {
        "schema": 1,
        "sourceCommit": version(["git", "rev-parse", "HEAD"]),
        "target": args.target,
        "runner": platform.platform(),
        "rust": version(["rustc", "--version"]),
        "cargo": version(["cargo", "--version"]),
        "node": version(["node", "--version"]),
        "profile": "release",
        "validation": "Build only; clipboard, drag/drop and timing require manual tests.",
        "signing": "ad-hoc; not notarized" if macos else "No Authenticode signature",
        "locks": before,
        "modes": [],
    }
    release = PROJECT / "src-tauri/target" / args.target / "release"
    with tempfile.TemporaryDirectory(prefix="intake-config-") as temporary:
        for mode in ("native", "html5"):
            config = configuration(mode, macos)
            config_path = Path(temporary) / (mode + ".json")
            config_path.write_text(json.dumps(config), encoding="utf-8")
            command = npm + ["exec", "--", "tauri", "build", "--ci", "--target", args.target,
                             "--config", str(config_path)]
            command += ["--bundles", "app"] if macos else ["--no-bundle"]
            run(command + ["--", "--locked"])
            if macos:
                source = release / "bundle/macos" / (config["productName"] + ".app")
                shutil.copytree(source, stage / source.name, symlinks=True)
            else:
                shutil.copy2(release / "rapidraw-intake-spike.exe", stage / ("intake-" + mode + ".exe"))
            metadata["modes"].append({
                "name": mode, "productName": config["productName"],
                "identifier": config["identifier"],
                "nativeDragDrop": config["app"]["windows"][0]["dragDropEnabled"],
            })
    examples = ["clipboard"] if macos else ["clipboard", "clipboard_contention"]
    command = ["cargo", "build", "--locked", "--release", "--no-default-features", "--target", args.target]
    for example in examples:
        command += ["--example", example]
    run(command, PROJECT / "src-tauri")
    for example in examples:
        extension = "" if macos else ".exe"
        shutil.copy2(release / "examples" / (example + extension), stage / (example.replace("_", "-") + extension))
    if not macos:
        shutil.copy2(PROJECT / "scripts/windows-clipboard-processes.ps1", stage)
    shutil.copy2(PROJECT / "CLIENTS.md", stage / "README.txt")
    if any(sha(p) != before[p.name] for p in locks):
        raise RuntimeError("Build changed a dependency lockfile")
    metadata["files"] = file_records(stage)
    (stage / "BUILD.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    archive = output / (stage.name + ".zip")
    if macos:
        # Artifact upload alone drops executable permissions; ditto retains app
        # bundle permissions, symlinks and macOS metadata inside this archive.
        run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", stage, archive])
    else:
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    package.write(path, path.relative_to(output))
    checksum = sha(archive)
    archive.with_suffix(".zip.sha256").write_text(checksum + "  " + archive.name + "\n", encoding="utf-8")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a", encoding="utf-8") as file:
            file.write("## Intake test clients: " + label + "\n\n")
            file.write("Source: `" + metadata["sourceCommit"] + "`\n\n")
            file.write("Download this job's artifact; extract its inner ZIP to run both modes. See README.txt and BUILD.json.\n\n")
            file.write("This is a build, not a manual-input test pass. macOS apps are ad-hoc signed and not notarized.\n")
    print(json.dumps({"archive": str(archive), "sha256": checksum, "sourceCommit": metadata["sourceCommit"]}))


if __name__ == "__main__":
    main()
