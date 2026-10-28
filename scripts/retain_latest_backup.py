"""Validate complete ShopMate backup pairs, then recycle predecessors on Windows."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from windows_recycle import checked_path, hidden_process_options, recycle_paths


def choose_backups(root: Path, directory: Path, node: str):
    valid, retained = [], []
    for path in sorted(directory.glob("shopmate-*.sqlite")):
        try:
            path = checked_path(path, directory)
            manifest = checked_path(Path(str(path) + ".manifest.json"), directory)
            before = (path.stat().st_size, path.stat().st_mtime_ns, manifest.stat().st_mtime_ns)
            result = subprocess.run([node, "--import", "tsx", "src/maintenance.ts", "inspect", str(path)], cwd=root / "backend", capture_output=True, text=True, encoding="utf-8", timeout=120, **hidden_process_options())
            if result.returncode:
                raise ValueError("BACKUP_VERIFICATION_FAILED")
            data = json.loads(result.stdout)
            if data.get("reason") not in ("daily", "manual", "preupgrade", "pre-restore"):
                raise ValueError("BACKUP_REASON_UNKNOWN")
            created = datetime.fromisoformat(data["createdAt"].replace("Z", "+00:00"))
            if created.tzinfo is None or (created - datetime.now(timezone.utc)).total_seconds() > 300:
                raise ValueError("BACKUP_TIME_INVALID")
            if before != (path.stat().st_size, path.stat().st_mtime_ns, manifest.stat().st_mtime_ns):
                raise ValueError("BACKUP_CHANGED_DURING_VERIFICATION")
            valid.append({"path": str(path), "manifest": str(manifest), "sha256": data["sha256"], "createdAt": data["createdAt"], "timestamp": created.timestamp(), "bytes": before[0]})
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            retained.append({"path": str(path), "reason": "incomplete, changed or unverified; retained"})
    valid.sort(key=lambda row: (row["timestamp"], row["path"]), reverse=True)
    if not valid:
        raise ValueError("No fully verified backup; nothing will be recycled")
    return valid, retained


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    directory = args.backup_dir.resolve(strict=True)
    if directory == root or not (root / "backend/src/maintenance.ts").is_file():
        raise ValueError("Explicit project and backup directories required")
    if os.name != "nt" and args.execute:
        raise OSError("Recycle-only execution requires Windows")
    log = root / ".delivery/latest-backup-retention/events.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    lock = None
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        kernel.CreateMutexW.restype = ctypes.c_void_p
        name = hashlib.sha256(str(directory).lower().encode()).hexdigest()[:24]
        lock = kernel.CreateMutexW(None, 1, "Local\\ShopMateBackupRetention-" + name)
        if not lock:
            raise OSError("Cannot acquire retention lock")
        if ctypes.get_last_error() == 183:
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle(lock)
            return
    try:
        valid, retained = choose_backups(root, directory, args.node)
        newest = valid[0]
        targets = [Path(item[key]) for item in valid[1:] for key in ("path", "manifest")]
        result = {"at": datetime.now(timezone.utc).isoformat(), "execute": args.execute, "latest": newest, "targets": [str(path) for path in targets], "retainedUnverified": retained}
        if args.execute and targets:
            with open(newest["path"], "rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != newest["sha256"]:
                    raise ValueError("Retained backup changed; nothing will be recycled")
            # Re-evaluate immediately: a completed newer backup must never be deleted.
            current = {str(path) for path in directory.glob("shopmate-*.sqlite")}
            if current != {item["path"] for item in valid} | {item["path"] for item in retained}:
                raise ValueError("Backup inventory changed; retry on the next run")
            result["recycled"] = recycle_paths(targets, directory)
        if result.get("recycled") or retained:
            with log.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(result, ensure_ascii=False) + "\n")
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        with log.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "error": str(error)}, ensure_ascii=False) + "\n")
        raise
    finally:
        if lock:
            kernel.ReleaseMutex.argtypes = [ctypes.c_void_p]
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel.ReleaseMutex(lock)
            kernel.CloseHandle(lock)


if __name__ == "__main__":
    main()
