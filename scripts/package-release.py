#!/usr/bin/env python3
"""Packages croakcode release binaries for the gate's download folder (Phase 6 Task 2).

    scripts/package-release.py --minimum 0.6.0 [--notes "..."] [--no-build] [targets...]

Builds the binaries with scripts/build-release.sh (unless --no-build), then
writes dist/release/<version>/ under upstream/packages/opencode:

    croakcode-<version>-<target>.tar.gz   linux and darwin
    croakcode-<version>-<target>.zip      windows
    SHA256SUMS
    manifest.json   latest, minimum, notes and every file's sha256 and size

Each archive holds bin/croakcode[.exe] and config/, the product config
(upstream/.croakcode as committed). The installer puts config/ at
~/.croakcode. A test build (X.Y.Z-dev.<commit>) is refused unless --dev.
"""
import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import zipfile
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.path.join(REPO, "upstream", "packages", "opencode")
TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"]
VERSION = re.compile(r"^\d+\.\d+\.\d+(-dev\.[0-9a-f]+)?$")


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def build(targets: list[str]) -> str:
    """Runs build-release.sh and returns the version it built."""
    done = subprocess.run(["bash", os.path.join(REPO, "scripts", "build-release.sh"), *targets],
                          cwd=REPO, capture_output=True, text=True)
    sys.stdout.write(done.stdout[-2000:])
    if done.returncode != 0:
        sys.stderr.write(done.stderr[-2000:])
        die("build failed")
    found = re.findall(r"^version (\S+)$", done.stdout, re.M)
    if not found:
        die("the build did not report a version")
    return found[-1]


def built_version(targets: list[str]) -> str:
    """The version of already built binaries, from the linux-x64 one when present."""
    marker = os.path.join(PKG, "dist", f"croakcode-{targets[0]}", "package.json")
    try:
        with open(marker, encoding="utf-8") as f:
            return json.load(f)["version"]
    except (OSError, KeyError, ValueError):
        die(f"no build found ({marker}); run without --no-build")
    return ""


def config_files() -> list[tuple[str, str]]:
    """(path in the archive, file on disk) for the committed product config."""
    listed = subprocess.run(["git", "ls-files", "upstream/.croakcode"], cwd=REPO, capture_output=True, text=True, check=True)
    files = []
    for rel in listed.stdout.split():
        name = os.path.basename(rel)
        if name in (".gitignore", ".gitkeep"):
            continue
        files.append(("config/" + rel[len("upstream/.croakcode/"):], os.path.join(REPO, rel)))
    return files


def binary(target: str) -> str:
    folder = os.path.join(PKG, "dist", f"croakcode-{target}", "bin")
    path = os.path.join(folder, "croakcode.exe" if target.startswith("windows") else "croakcode")
    if not os.path.isfile(path):
        die(f"missing binary for {target}: {path}")
    return path


def archive(target: str, version: str, out_dir: str) -> str:
    entries = [("bin/" + os.path.basename(binary(target)), binary(target)), *config_files()]
    if target.startswith("windows"):
        name = f"croakcode-{version}-{target}.zip"
        with zipfile.ZipFile(os.path.join(out_dir, name), "w", zipfile.ZIP_DEFLATED) as z:
            for arc, path in entries:
                z.write(path, arc)
        return name
    name = f"croakcode-{version}-{target}.tar.gz"
    with tarfile.open(os.path.join(out_dir, name), "w:gz") as t:
        for arc, path in entries:
            info = t.gettarinfo(path, arc)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o755 if arc.startswith("bin/") else 0o644
            with open(path, "rb") as f:
                t.addfile(info, f)
    return name


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def key(version: str) -> tuple[int, ...]:
    return tuple(int(x) for x in version.split("-")[0].split("."))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("targets", nargs="*", default=TARGETS)
    parser.add_argument("--minimum", required=True, help="lowest version that may still be used (a required update below it)")
    parser.add_argument("--notes", default="", help="what changed, shown with an update notice")
    parser.add_argument("--no-build", action="store_true", help="package binaries already in dist/")
    parser.add_argument("--dev", action="store_true", help="allow a test build (X.Y.Z-dev.<commit>)")
    args = parser.parse_args()
    unknown = [t for t in args.targets if t not in TARGETS]
    if unknown:
        die(f"unknown targets {unknown}; choose from {TARGETS}")
    if not VERSION.match(args.minimum) or "-dev." in args.minimum:
        die("--minimum must be a release version X.Y.Z")

    version = built_version(args.targets) if args.no_build else build(args.targets)
    if not VERSION.match(version):
        die(f"unexpected version {version}")
    if "-dev." in version and not args.dev:
        die(f"{version} is a test build; tag vX.Y.Z on a clean HEAD, or pass --dev")
    if key(args.minimum) > key(version):
        die(f"--minimum {args.minimum} is newer than this release {version}")

    out_dir = os.path.join(PKG, "dist", "release", version)
    os.makedirs(out_dir, exist_ok=True)
    files = {}
    for target in args.targets:
        name = archive(target, version, out_dir)
        path = os.path.join(out_dir, name)
        files[target] = {"file": name, "sha256": sha256(path), "size": os.path.getsize(path)}
        print(f"{name:44} {files[target]['size'] // 1024 // 1024:4} MB  {files[target]['sha256'][:16]}")

    with open(os.path.join(out_dir, "SHA256SUMS"), "w", encoding="utf-8") as f:
        for item in files.values():
            f.write(f"{item['sha256']}  {item['file']}\n")
    manifest = {
        "product": "croakcode",
        "latest": version,
        "minimum": args.minimum,
        "released": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "notes": args.notes,
        "files": files,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"wrote {os.path.relpath(out_dir, REPO)}: {len(files)} archives, SHA256SUMS, manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
