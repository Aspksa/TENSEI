#!/usr/bin/env python3
"""Optional lightweight localhost RapidOCR CPU service for TENSEI.

Not started by TENSEI.bat. One request at a time. Defaults to unloading the
OCR model after each call to minimize laptop idle memory use. Coordinates and
text are advisory; handwritten numbers are never automatically verified.
"""
import base64
import hashlib
import tempfile
from pathlib import Path
from cell_cache import cache_root
import gc
import importlib.util
import io
import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                 "NUMEXPR_NUM_THREADS", "ORT_INTRA_OP_NUM_THREADS"):
    os.environ[variable] = "1"

HOST = "127.0.0.1"
PORT = int(os.environ.get("TENSEI_RAPIDOCR_PORT", "8767"))
MAX_PAYLOAD = 9_000_000
KEEP_WARM = os.environ.get("TENSEI_RAPIDOCR_KEEP_WARM") == "1"
_engine = None


def decode_image(data):
    if not isinstance(data, str) or len(data) > MAX_PAYLOAD:
        raise ValueError("Invalid image size")
    m = re.fullmatch(r"data:image/jpeg;base64,([A-Za-z0-9+/=]+)", data)
    if not m:
        raise ValueError("Expected JPEG data URL")
    binary = base64.b64decode(m.group(1), validate=True)
    if len(binary) > 6_000_000:
        raise ValueError("JPEG exceeds 6 MB")
    from PIL import Image
    with Image.open(io.BytesIO(binary)) as img:
        if img.format != "JPEG" or img.width * img.height > 20_000_000:
            raise ValueError("Invalid or oversized JPEG")
        return binary, img.width, img.height


def normalize_output(result, width, height):
    texts = result.txts if getattr(result, "txts", None) is not None else []
    scores = result.scores if getattr(result, "scores", None) is not None else []
    boxes = result.boxes if getattr(result, "boxes", None) is not None else []
    lines = []
    for index, text in enumerate(list(texts)[:250]):
        if not isinstance(text, str):
            continue
        if index >= len(boxes):
            continue
        box = boxes[index]
        if hasattr(box, "tolist"):
            box = box.tolist()
        if not isinstance(box, (list, tuple)) or len(box) < 4:
            continue
        try:
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            rect = [max(0, min(xs)/width), max(0, min(ys)/height),
                    min(1, max(xs)/width), min(1, max(ys)/height)]
        except (TypeError, IndexError, ValueError, ZeroDivisionError):
            continue
        if rect[2] <= rect[0] or rect[3] <= rect[1]:
            continue
        score = float(scores[index]) if index < len(scores) else None
        lines.append({"text": text[:180], "bbox": [round(v, 6) for v in rect],
                      "score": round(score, 4) if score is not None else None,
                      "verified": False})
    return {"engine": "RapidOCR CPU ONNX", "lines": lines,
            "recognized_cells": [], "verified": False, "localOnly": True}


def _cache_path(binary):
    digest = hashlib.sha256(b"rapidocr-onnx-cpu-v1\\0" + binary).hexdigest()
    return cache_root() / "rapidocr" / (digest + ".json")


def read_result(binary):
    try:
        data = json.loads(_cache_path(binary).read_text(encoding="utf-8"))
        if data.get("engine") != "RapidOCR CPU ONNX" or data.get("verified") is not False:
            return None
        if not isinstance(data.get("lines"), list):
            return None
        return {"engine": data["engine"], "lines": data["lines"][:250],
                "recognized_cells": [], "verified": False, "localOnly": True, "cached": True}
    except (OSError, ValueError, KeyError):
        return None


def write_result(binary, output):
    path = _cache_path(binary)
    tmp = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", dir=path.parent, encoding="utf-8",
                                         suffix=".tmp", delete=False) as fh:
            tmp = fh.name
            json.dump({**output, "verified": False}, fh, ensure_ascii=False)
        os.replace(tmp, path)
        entries = sorted(path.parent.glob("*.json"), key=lambda p: p.stat().st_mtime)
        for stale in entries[:max(0, len(entries) - 500)]:
            stale.unlink(missing_ok=True)
    except OSError:
        pass
    finally:
        if tmp:
            Path(tmp).unlink(missing_ok=True)


def run_ocr(binary, width, height):
    global _engine
    from rapidocr import RapidOCR
    saved = read_result(binary)
    if saved is not None:
        return saved
    try:
        if _engine is None:
            _engine = RapidOCR()
        result = _engine(binary)
        output = normalize_output(result, width, height)
        write_result(binary, output)
        return {**output, 'cached': False}
    finally:
        if not KEEP_WARM:
            _engine = None
            gc.collect()


def run_rotated_digits(binary):
    """Operator-requested ±8 degree variants only. No auto-accept and no cloud."""
    from PIL import Image
    from rapidocr import RapidOCR
    global _engine
    results = []
    try:
        if _engine is None:
            _engine = RapidOCR()
        for degrees in (0, -8, 8):
            if degrees == 0:
                rotated = binary
            else:
                with Image.open(io.BytesIO(binary)) as original:
                    image = original.convert("RGB")
                image = image.rotate(degrees, resample=Image.Resampling.BICUBIC,
                                     expand=False, fillcolor="white")
                buf = io.BytesIO()
                image.save(buf, format="JPEG", quality=91)
                rotated = buf.getvalue()
            with Image.open(io.BytesIO(rotated)) as info:
                result = normalize_output(_engine(rotated), info.width, info.height)
            results.append({"rotationDegrees": degrees,
                            "readings": [line["text"] for line in result["lines"][:8]],
                            "verified": False})
        return {"engine": "RapidOCR CPU ONNX", "variants": results,
                "verified": False, "localOnly": True,
                "note": "Угол -8 или +8 градусов — только кандидат. Сверяйте по оригиналу."}
    finally:
        if not KEEP_WARM:
            _engine = None
            gc.collect()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/health":
            self._send(404, {"error": "Not found"})
            return
        self._send(200, {"ok": True, "installed": importlib.util.find_spec("rapidocr") is not None,
                         "engine": "RapidOCR CPU ONNX",
                         "maxConcurrent": 1, "keepWarm": KEEP_WARM,
                         "verified": False})

    def do_POST(self):
        if self.path != "/ocr":
            self._send(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_PAYLOAD + 500:
                raise ValueError("Invalid payload size")
            obj = json.loads(self.rfile.read(length))
            binary, width, height = decode_image(obj.get("image"))
            if obj.get("mode") == "digit-variants":
                if width * height > 1_500_000:
                    raise ValueError("Digit-variant crop is too large")
                self._send(200, run_rotated_digits(binary))
            else:
                self._send(200, run_ocr(binary, width, height))
        except Exception as exc:
            self._send(422, {"error": str(exc)[:180]})

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    HTTPServer((HOST, PORT), Handler).serve_forever()
