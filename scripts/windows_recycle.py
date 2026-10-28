"""Windows recycle-only operations. There is deliberately no permanent-delete fallback."""
from __future__ import annotations

import ctypes
import os
from pathlib import Path
import re
import struct
import subprocess
import time
import uuid


def hidden_process_options() -> dict:
    """Console children of pythonw must not create their own Windows console."""
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def checked_path(value: str | Path, allowed_root: Path) -> Path:
    original = Path(value).absolute()
    root = allowed_root.resolve(strict=True)
    if original.is_symlink() or getattr(original.lstat(), "st_file_attributes", 0) & 0x400:
        raise ValueError(f"Reparse points are not cleanup targets: {original}")
    resolved = original.resolve(strict=True)
    if resolved == root or not resolved.is_relative_to(root):
        raise ValueError(f"Cleanup target outside its allowed directory: {original}")
    return resolved


def _native_recycle(paths: list[Path]) -> None:
    if os.name != "nt":
        raise OSError("Recycle-only execution requires Windows")
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [("bytes", ctypes.c_ubyte * 16)]

        @classmethod
        def of(cls, value: str):
            return cls((ctypes.c_ubyte * 16).from_buffer_copy(uuid.UUID(value).bytes_le))

    def check(hr):
        if hr < 0:
            raise OSError(f"Windows recycle operation failed: 0x{hr & 0xffffffff:08x}")

    def method(pointer, slot, result, *arguments):
        table = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        return ctypes.WINFUNCTYPE(result, ctypes.c_void_p, *arguments)(table[slot])

    ole = ctypes.OleDLL("ole32")
    shell = ctypes.WinDLL("shell32")
    ole.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole.CoInitializeEx.restype = ctypes.c_long
    ole.CoCreateInstance.argtypes = [ctypes.POINTER(GUID), ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
    ole.CoCreateInstance.restype = ctypes.c_long
    shell.SHCreateItemFromParsingName.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
    shell.SHCreateItemFromParsingName.restype = ctypes.c_long
    check(ole.CoInitializeEx(None, 2))
    operation = ctypes.c_void_p()
    items = []
    try:
        cls = GUID.of("3ad05575-8857-4850-9277-11b85bdb8e09")
        iid = GUID.of("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8")
        check(ole.CoCreateInstance(ctypes.byref(cls), None, 1, ctypes.byref(iid), ctypes.byref(operation)))
        # RECYCLEONDELETE + EARLYFAILURE: never fall back to permanent deletion or skip errors.
        flags = 0x00080000 | 0x00100000 | 0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x2000
        check(method(operation, 5, ctypes.c_long, wintypes.DWORD)(operation, flags))
        item_iid = GUID.of("43826d1e-e718-42ee-bc55-a1e261c37bfe")
        for path in paths:
            item = ctypes.c_void_p()
            check(shell.SHCreateItemFromParsingName(str(path), None, ctypes.byref(item_iid), ctypes.byref(item)))
            items.append(item)
            check(method(operation, 18, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)(operation, item, None))
        check(method(operation, 21, ctypes.c_long)(operation))
        aborted = wintypes.BOOL()
        check(method(operation, 22, ctypes.c_long, ctypes.POINTER(wintypes.BOOL))(operation, ctypes.byref(aborted)))
        if aborted.value:
            raise OSError("Windows recycle operation was aborted")
    finally:
        for item in items:
            method(item, 2, wintypes.ULONG)(item)
        if operation.value:
            method(operation, 2, wintypes.ULONG)(operation)
        ole.CoUninitialize()


def recycle_paths(values: list[Path], allowed_root: Path) -> list[dict]:
    paths = [checked_path(path, allowed_root) for path in values]
    if not paths:
        return []
    identity = subprocess.check_output(["whoami", "/user", "/fo", "csv", "/nh"], **hidden_process_options())
    sid = re.search(rb"S-1-[0-9-]+", identity)
    if not sid:
        raise OSError("Cannot establish current Recycle Bin owner")
    wanted = {os.path.normcase(str(path)): path for path in paths}
    bins = {Path(path.anchor) / "$Recycle.Bin" / sid.group().decode("ascii") for path in paths}
    _native_recycle(paths)
    receipts = {}
    for _ in range(20):
        for directory in bins:
            for index in directory.glob("$I*"):
                try:
                    raw = index.read_bytes()
                    version, size, recycled_at = struct.unpack_from("<QQQ", raw)
                    offset = 28 if version == 2 else 24
                    if version not in (1, 2):
                        continue
                    original = raw[offset:].decode("utf-16le").rstrip("\0")
                    key = os.path.normcase(original)
                    payload = index.with_name("$R" + index.name[2:])
                    if key in wanted and payload.exists():
                        receipts[key] = {"original": original, "index": str(index), "payload": str(payload), "bytes": size, "recycledAtFiletime": recycled_at}
                except (OSError, ValueError, UnicodeError, struct.error):
                    continue
        if all(not path.exists() and key in receipts for key, path in wanted.items()):
            return [receipts[key] for key in wanted]
        time.sleep(0.1)
    raise OSError("Recycle receipts incomplete; retain the journal and check the exact target paths")
