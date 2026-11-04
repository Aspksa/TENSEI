"""Persistent advisory OCR candidate cache keyed by EXACT crop bytes and OCR version.

Cache hits are not ground truth. Restricted to localhost OCR; never used to
populate approved transport records without an operator review.
"""
import hashlib
import json
import os
from pathlib import Path
import tempfile

CACHE_VERSION = "ppocrv6-crops-v2"


def cache_root():
    base = os.environ.get("TENSEI_CELL_CACHE_DIR")
    if base:
        return Path(base).expanduser().resolve()
    data = os.environ.get("TENSEI_DATA_DIR")
    if data:
        return Path(data).expanduser().resolve() / "cell-ocr-cache"
    return Path(__file__).resolve().parent.parent / "data" / "cell-ocr-cache"


def cache_key(image_bytes, version=CACHE_VERSION):
    if not isinstance(image_bytes, bytes):
        raise ValueError("Expected exact image bytes")
    return hashlib.sha256(version.encode() + b"\0" + image_bytes).hexdigest()


def read_cache(key, root=None):
    if not isinstance(key, str) or len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
        return None
    directory = Path(root) if root is not None else cache_root()
    try:
        path = directory / (key + ".json")
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("version") != CACHE_VERSION or data.get("verified") is not False:
            return None
        return {k: data[k] for k in ["text", "score", "numericCandidate", "verified"] if k in data}
    except (OSError, ValueError, KeyError):
        return None


def write_cache(key, record, root=None, limit=1500):
    if not isinstance(key, str) or len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
        return False
    directory = Path(root) if root is not None else cache_root()
    allowed = {"text": str(record.get("text") or "")[:80],
               "score": record.get("score"), "numericCandidate": record.get("numericCandidate") is True,
               "verified": False, "version": CACHE_VERSION}
    if not isinstance(allowed["score"], (int, float, type(None))):
        allowed["score"] = None
    tmp_name = None
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory,
                                         prefix=key[:12], suffix=".tmp", delete=False) as temp:
            tmp_name = temp.name
            json.dump(allowed, temp, ensure_ascii=False)
        os.replace(tmp_name, directory / (key + ".json"))
        existing = sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime)
        for old in existing[:max(0, len(existing) - max(1, limit))]:
            old.unlink(missing_ok=True)
        return True
    except OSError:
        return False
    finally:
        if tmp_name:
            try:
                Path(tmp_name).unlink(missing_ok=True)
            except OSError:
                pass
