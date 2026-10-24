"""Generate fictional colour-only HEVC fixtures with a maintained native test encoder.

Use an isolated venv with pillow-heif==1.8.1 and Pillow==12.2.0. No production
encoder, downloaded personal photo, or system-wide installation is required.
"""
import hashlib
import json
from pathlib import Path

from PIL import Image
import pillow_heif

pillow_heif.register_heif_opener()
directory = Path(__file__).resolve().parents[1] / "fixtures" / "media"
directory.mkdir(parents=True, exist_ok=True)
image = Image.new("RGB", (64, 32), (106, 25, 43))
exif = Image.Exif()
exif[274] = 6
exif[315] = "FICTIONAL_HEIC_METADATA_TO_STRIP"
exif[34853] = {1: "N", 2: (1.0, 0.0, 0.0), 3: "E", 4: (1.0, 0.0, 0.0)}
image.save(directory / "fictional.heic", format="HEIF", quality=90, exif=exif.tobytes())
image.save(directory / "multiple.heic", format="HEIF", quality=90, save_all=True, append_images=[Image.new("RGB", (16, 16), (23, 107, 69))])
thumbnail = pillow_heif.from_pillow(Image.new("RGB", (256, 192), (106, 25, 43)))
thumbnail[0].info["thumbnails"] = [32]
thumbnail.save(directory / "with-thumbnail.heic", quality=90)
original = (directory / "with-thumbnail.heic").read_bytes()
positions = []
offset = 0
while (offset := original.find(b"ispe", offset)) >= 0:
    positions.append(offset)
    offset += 4
assert len(positions) == 2, "Expected a primary image and a hidden thumbnail property."
altered = bytearray(original)
offset = positions[-1]
altered[offset + 8:offset + 12] = (100000).to_bytes(4, "big")
altered[offset + 12:offset + 16] = (100000).to_bytes(4, "big")
(directory / "hidden-oversize.heic").write_bytes(altered)
report = {
    "syntheticOnly": True,
    "description": "Generated flat colours only; no people or personal metadata. EXIF/GPS values are deliberate fictional strip controls.",
    "encoder": pillow_heif.libheif_info(),
    "fixtures": [{"file": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(directory.glob("*.heic"))],
    "hiddenThumbnailIspeOffset": offset,
}
(directory / "heic-fixtures.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
