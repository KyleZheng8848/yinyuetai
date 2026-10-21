#!/usr/bin/env python3
"""Resumable, checksummed ModelScope downloader used by Yinyuetai Studio."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import quote

import httpx


def log(message: str) -> None:
    print(message, flush=True)


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def verify(file_path: Path, expected_bytes: int, expected_sha256: str = "") -> None:
    actual_bytes = file_path.stat().st_size
    if actual_bytes != expected_bytes:
        raise RuntimeError(f"size mismatch: expected {expected_bytes}, got {actual_bytes}")
    if expected_sha256:
        actual_sha256 = sha256_file(file_path)
        if actual_sha256 != expected_sha256:
            raise RuntimeError(f"SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}")


def safe_target(root: Path, relative_name: str) -> Path:
    target = (root / relative_name).resolve()
    target.relative_to(root)
    return target


def model_url(repository: str, revision: str, relative_name: str) -> str:
    encoded_file = "/".join(quote(part, safe="") for part in relative_name.split("/"))
    return f"https://modelscope.cn/models/{repository}/resolve/{quote(revision, safe='')}/{encoded_file}"


def download_once(repository: str, revision: str, root: Path, entry: dict) -> Path:
    relative_name = str(entry["name"])
    source_name = str(entry.get("sourceName") or relative_name)
    expected_bytes = int(entry["bytes"])
    expected_sha256 = str(entry.get("sha256") or "")
    target = safe_target(root, relative_name)
    partial = Path(f"{target}.part")
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists():
        try:
            verify(target, expected_bytes, expected_sha256)
            log(f"SKIP {relative_name} {expected_bytes}")
            return target
        except Exception:
            target.unlink()

    if partial.exists() and partial.stat().st_size == expected_bytes:
        verify(partial, expected_bytes, expected_sha256)
        os.replace(partial, target)
        log(f"DONE {relative_name} {expected_bytes}")
        return target
    if partial.exists() and partial.stat().st_size > expected_bytes:
        partial.unlink()

    existing = partial.stat().st_size if partial.exists() else 0
    headers = {
        "Accept-Encoding": "identity",
        "User-Agent": "Yinyuetai-Studio/1.14.0 model-downloader",
        **({"Range": f"bytes={existing}-"} if existing else {}),
    }
    timeout = httpx.Timeout(connect=30.0, read=120.0, write=120.0, pool=30.0)
    with httpx.Client(follow_redirects=True, timeout=timeout, trust_env=True) as client:
        with client.stream("GET", model_url(repository, revision, source_name), headers=headers) as response:
            if response.status_code == 416 and existing == expected_bytes:
                verify(partial, expected_bytes, expected_sha256)
                os.replace(partial, target)
                return target
            response.raise_for_status()
            resumed = existing if response.status_code == 206 else 0
            mode = "ab" if resumed else "wb"
            received = resumed
            last_report = time.monotonic()
            with partial.open(mode) as output:
                for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                    output.write(chunk)
                    received += len(chunk)
                    now = time.monotonic()
                    if now - last_report >= 3:
                        log(f"PROGRESS {relative_name} {received} {expected_bytes}")
                        last_report = now
    verify(partial, expected_bytes, expected_sha256)
    os.replace(partial, target)
    log(f"DONE {relative_name} {expected_bytes}")
    return target


def download_with_retry(repository: str, revision: str, root: Path, entry: dict) -> Path:
    relative_name = str(entry["name"])
    last_error: Exception | None = None
    for attempt in range(1, 9):
        try:
            return download_once(repository, revision, root, entry)
        except Exception as error:
            last_error = error
            partial = Path(f"{safe_target(root, relative_name)}.part")
            if "SHA-256 mismatch" in str(error) and partial.exists():
                partial.unlink()
            if attempt >= 8:
                break
            wait_seconds = min(30, 2 ** (attempt - 1))
            resumed = partial.stat().st_size if partial.exists() else 0
            log(f"RETRY {relative_name} {attempt + 1}/8 from={resumed} wait={wait_seconds}s error={error}")
            time.sleep(wait_seconds)
    raise RuntimeError(f"{relative_name} failed after 8 attempts: {last_error}")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: modelscope_parallel_downloader.py request.json")
    request_path = Path(sys.argv[1])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    root = Path(request["root"]).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    repository = str(request["repository"])
    revision = str(request.get("revision") or "master")
    files = list(request["files"])
    workers = max(1, min(3, int(request.get("workers") or 3)))
    log(f"ModelScope parallel downloader: {repository} · files={len(files)} · workers={workers}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(download_with_retry, repository, revision, root, entry) for entry in files]
        for future in concurrent.futures.as_completed(futures):
            future.result()
    log("ModelScope download and file verification complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
