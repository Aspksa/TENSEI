#!/usr/bin/env python3
"""Optional localhost-only PP-StructureV3 layout service for TENSEI.

Install this only on machines where local PaddleOCR is wanted:
  py -3.11 -m venv .paddle-venv
  .paddle-venv\Scripts\python -m pip install -r scripts/paddle-requirements.txt
  .paddle-venv\Scripts\python scripts/paddle_service.py
"""
import base64
import io
import re
import threading
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
import uvicorn

app = FastAPI(title="TENSEI optional PaddleOCR")
_model = None
_ocr_model = None
_vl_model = None
_lock = threading.RLock()


class Photo(BaseModel):
    image: str


def model():
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from paddleocr import PPStructureV3
                _model = PPStructureV3(
                    use_doc_preprocessor=True,
                    use_table_recognition=True,
                    use_formula_recognition=False,
                    use_seal_recognition=False,
                )
    return _model


def box_to_xyxy(raw: Any, width: int, height: int):
    if hasattr(raw, "tolist"):
        raw = raw.tolist()
    if isinstance(raw, dict):
        raw = raw.get("coordinate", raw.get("box"))
    if not isinstance(raw, (list, tuple)) or len(raw) < 4:
        return None
    if isinstance(raw[0], (list, tuple)):
        if len(raw) < 4:
            return None
        xs = [float(point[0]) for point in raw]
        ys = [float(point[1]) for point in raw]
        raw = [min(xs), min(ys), max(xs), max(ys)]
    else:
        raw = [float(value) for value in raw[:4]]
    if max(raw) <= 1:
        x1, y1, x2, y2 = raw
    else:
        x1, y1, x2, y2 = (raw[0]/width, raw[1]/height, raw[2]/width, raw[3]/height)
    result = [round(max(0.0, min(1.0, v)), 6) for v in (x1, y1, x2, y2)]
    return result if result[2] > result[0] and result[3] > result[1] else None


def cluster_rows(boxes: list[list[float]]):
    if not boxes:
        return []
    rows = []
    for b in sorted(boxes, key=lambda z: (z[1]+z[3])/2):
        center = (b[1]+b[3])/2
        candidate = next((row for row in rows if row["top"] <= center <= row["bottom"]), None)
        if candidate is None:
            rows.append({"top": b[1], "bottom": b[3], "count": 1})
        else:
            candidate["top"] = min(candidate["top"], b[1])
            candidate["bottom"] = max(candidate["bottom"], b[3])
            candidate["count"] += 1
    return [[0, max(0, x["top"]-.008), 1, min(1, x["bottom"]+.008)]
            for x in rows if x["count"] >= 2][:100]


@app.get("/health")
def health():
    return {"ok": True, "engine": "PaddleOCR PP-StructureV3", "loaded": _model is not None}


@app.post("/analyze")
def analyze(photo: Photo):
    try:
        if len(photo.image) > 12_000_000:
            raise ValueError("Image too large")
        payload = re.match(r"^data:image/jpeg;base64,([A-Za-z0-9+/=]+)$", photo.image)
        if payload is None:
            raise ValueError("Expected JPEG data URL")
        raw = base64.b64decode(payload.group(1), validate=True)
        with Image.open(io.BytesIO(raw)) as img:
            img = img.convert("RGB")
            w, h = img.size
            if w*h > 60_000_000:
                raise ValueError("Too many pixels")
            image = np.asarray(img)
        with _lock:
            # Can take time or download model weights on first request.
            result = next(iter(model().predict(input=image)))
        report = result.json if hasattr(result, "json") else result
        if callable(report):
            report = report()
        report = report.get("res", report)
        cells = []
        for table in report.get("table_res_list") or []:
            for item in table.get("cell_box_list") or []:
                value = box_to_xyxy(item, w, h)
                if value:
                    cells.append(value)
        return {"engine": "PP-StructureV3", "width": w, "height": h,
                "cells": cells[:800], "row_boxes": cluster_rows(cells)}
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:350]) from exc


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, access_log=False)


def decode_photo(photo: Photo):
    if len(photo.image) > 12_000_000:
        raise ValueError("Image too large")
    payload = re.match(r"^data:image/jpeg;base64,([A-Za-z0-9+/=]+)$", photo.image)
    if payload is None:
        raise ValueError("Expected JPEG data URL")
    raw = base64.b64decode(payload.group(1), validate=True)
    with Image.open(io.BytesIO(raw)) as img:
        img = img.convert("RGB")
        if img.width * img.height > 60_000_000:
            raise ValueError("Too many pixels")
        return np.asarray(img)


def model_ocr():
    global _ocr_model
    if _ocr_model is None:
        with _lock:
            if _ocr_model is None:
                from paddleocr import PaddleOCR
                _ocr_model = PaddleOCR(
                    use_doc_orientation_classify=True,
                    use_doc_unwarping=True,
                    use_textline_orientation=False,
                )
    return _ocr_model


def model_vl():
    global _vl_model
    if _vl_model is None:
        with _lock:
            if _vl_model is None:
                from paddleocr import PaddleOCRVL
                _vl_model = PaddleOCRVL(use_doc_orientation_classify=True,
                                        use_doc_unwarping=True)
    return _vl_model


@app.post("/ocr")
def recognize_lines(photo: Photo):
    """Advisory local text lines, not a verified weighbridge table."""
    try:
        image = decode_photo(photo)
        with _lock:
            prediction = next(iter(model_ocr().predict(image)))
        report = prediction.json if hasattr(prediction, "json") else prediction
        if callable(report):
            report = report()
        report = report.get("res", report)
        lines = []
        for text, score in zip(report.get("rec_texts") or [],
                               report.get("rec_scores") or []):
            if isinstance(text, str):
                lines.append({"text": text[:200], "score": round(float(score), 4)})
        return {"engine": "PP-OCRv6", "lines": lines[:400], "verified": False}
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:350]) from exc


@app.post("/vl")
def understand_page(photo: Photo):
    """Experimental PaddleOCR-VL; result is diagnostic only, never auto-applied."""
    try:
        image = decode_photo(photo)
        with _lock:
            prediction = next(iter(model_vl().predict(image)))
        report = prediction.json if hasattr(prediction, "json") else prediction
        if callable(report):
            report = report()
        if not isinstance(report, dict):
            raise ValueError("Unexpected PaddleOCR-VL output")
        import json
        payload = json.dumps(report, ensure_ascii=False, default=str)[:16000]
        return {"engine": "PaddleOCR-VL", "raw": payload, "verified": False}
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:350]) from exc
