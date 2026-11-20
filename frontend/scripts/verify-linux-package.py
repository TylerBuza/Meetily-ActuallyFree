#!/usr/bin/env python3
"""Inspect actual DEB/AppImage payloads; never install or access user app data."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / "frontend/src-tauri/tauri.conf.json").read_text())["version"]


def run(*args, **kwargs):
    try:
        return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, timeout=120, **kwargs).stdout
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"{args[0]} exited with {error.returncode}:\n{error.stdout}") from None


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def payload(root):
    bins = root / "usr/bin"
    require(not (bins / "ffmpeg").exists(), "Package must not own distro /usr/bin/ffmpeg")
    for name in ("meetily", "llama-helper", "meetily-ffmpeg"):
        binary = bins / name
        require(binary.is_file() and os.access(binary, os.X_OK), f"Missing executable {binary}")
        with binary.open("rb") as elf:
            require(elf.read(4) == b"\x7fELF", f"Not ELF: {binary}")
        info = subprocess.run(["ldd", str(binary)], text=True, capture_output=True)
        require("not found" not in info.stdout, f"Unresolved native dependency: {info.stdout}")
    require("ffmpeg version" in run(str(bins / "meetily-ffmpeg"), "-version"), "FFmpeg cannot run")
    # EOF exercises helper startup/loader without requiring a private model.
    run(str(bins / "llama-helper"), input="")
    for name in ("segmentation-3.0-fp16.onnx", "wespeaker-resnet34-LM.onnx"):
        files = list(root.rglob(name))
        require(len(files) == 1 and files[0].stat().st_size > 1_000_000, f"Missing model/LFS payload: {name}")
    require(any(root.rglob("parakeet-rs-LICENSE.txt")), "Missing model attribution")
    require(any(root.rglob("*.desktop")), "Missing desktop entry")
    require(any((root / "usr/share/icons").rglob("*.png")), "Missing Linux icons")


def main():
    bundle = Path(sys.argv[1]).resolve()
    debs = list((bundle / "deb").glob("*.deb"))
    images = list((bundle / "appimage").glob("*.AppImage"))
    require(len(debs) == 1 and len(images) == 1, "Expected exactly one DEB and one AppImage")
    for deb in debs:
        require(run("dpkg-deb", "-f", str(deb), "Version").strip() == VERSION, "DEB version mismatch")
        require(run("dpkg-deb", "-f", str(deb), "Architecture").strip() == "amd64", "Wrong DEB architecture")
        dependencies = run("dpkg-deb", "-f", str(deb), "Depends")
        declared = {part.partition(" (")[0].strip()
                    for entry in dependencies.split(",") for part in entry.split("|")}
        required = ("libpulse0", "libasound2", "libgomp1", "gstreamer1.0-libav",
                    "gstreamer1.0-plugins-good", "gstreamer1.0-plugins-bad")
        for package in required:
            require(package in declared, f"DEB missing {package}")
        with tempfile.TemporaryDirectory(prefix="meetily-deb-") as tmp:
            run("dpkg-deb", "-x", str(deb), tmp)
            dynamic = run("readelf", "-d", str(Path(tmp) / "usr/bin/meetily"))
            if "[libvulkan.so.1]" in dynamic:
                require("libvulkan1" in declared, "Vulkan DEB missing the Vulkan loader (libvulkan1)")
            payload(Path(tmp))
            if "--smoke" in sys.argv:
                print(run(sys.executable, str(ROOT / "frontend/scripts/smoke-linux-app.py"),
                          str(Path(tmp) / "usr/bin/meetily")))
        print(f"PASS DEB payload: {deb.name}")
    for image in images:
        with tempfile.TemporaryDirectory(prefix="meetily-appimage-") as tmp:
            run(str(image), "--appimage-extract", cwd=tmp)
            payload(Path(tmp) / "squashfs-root")
            if "--smoke" in sys.argv:
                print(run(sys.executable, str(ROOT / "frontend/scripts/smoke-linux-app.py"),
                          str(image)))
        print(f"PASS AppImage payload: {image.name}")


if __name__ == "__main__":
    main()
