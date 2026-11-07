"""Create a disposable 164-file workload from public, genuine camera RAWs.

Requires rawpy and Pillow. Usage: python make-fixture.py SOURCE_DIR OUTPUT_DIR
Download the files in baseline/sources.json into SOURCE_DIR first.
Never point OUTPUT_DIR at an existing photo collection.
"""

import hashlib
import json
from pathlib import Path
import shutil
import sys

import rawpy
from PIL import Image, ImageEnhance


source_dir, output_dir = map(Path, sys.argv[1:])
if output_dir.exists():
    raise SystemExit("Output directory must not already exist")
sources = json.loads((Path(__file__).parents[1] / "sources.json").read_text())
decoded = []
for source in sources:
    path = source_dir / source["name"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == source["sha256"]
    with rawpy.imread(str(path)) as raw:
        source["camera"] = str(raw.raw_type)
        source["raw_dimensions"] = [raw.sizes.raw_width, raw.sizes.raw_height]
        decoded.append(Image.fromarray(raw.postprocess(use_camera_wb=True)))
output_dir.mkdir(parents=True)
rows = []
folders = ["set-a", "日本語 [set b]", "set-c", "set-d"]
for index in range(164):
    source_index = (index // 2) % len(sources)
    source = sources[source_index]
    is_raw = index % 2 == 0
    folder = output_dir / folders[index % 4]
    folder.mkdir(exist_ok=True)
    suffix = Path(source["name"]).suffix if is_raw else ".jpg"
    path = folder / f"photo-{index:03d}{suffix}"
    if is_raw:
        shutil.copyfile(source_dir / source["name"], path)
    else:
        # Retain native resolution; vary JPEG brightness for visual navigation.
        image = ImageEnhance.Brightness(decoded[source_index]).enhance(
            0.8 + (index % 11) * 0.04
        )
        image.save(path, quality=92, exif=b"")
    rows.append({"path": str(path.relative_to(output_dir)), "kind": "RAW" if is_raw else "JPEG",
                 "source": source["name"], "bytes": path.stat().st_size,
                 "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
(output_dir / "manifest.json").write_text(
    json.dumps({"sources": sources, "files": rows, "raw_count": 82, "jpeg_count": 82,
                "limitation": "2 source photographs, repeated RAW bytes; derived JPEGs; no removable drive"},
               indent=2, ensure_ascii=False), encoding="utf-8"
)
print(f"Created {len(rows)} files; genuine RAWs decoded by LibRaw/rawpy {rawpy.__version__}")
