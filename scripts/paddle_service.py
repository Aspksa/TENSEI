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
from grid_geometry import detect_grid, detect_text_bands, detect_crossout_candidates
from cell_cache import cache_key,read_cache,write_cache

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
        geometry = detect_grid(image)
        if geometry["cells"]:
            # Clear ruled grids give more reproducible cell positions than
            # spatial grouping of detached handwriting characters.
            return {"engine": "OpenCV grid + PP-StructureV3",
                    "width": w, "height": h, **geometry,
                    "paddle_cell_count": len(cells),
                    "layout_source": "ruling"}
        tentative = detect_text_bands(image) if not cells else {"row_boxes": []}
        return {"engine": "PP-StructureV3", "width": w, "height": h,
                "cells": cells[:800], "row_boxes": cluster_rows(cells) or tentative["row_boxes"],
                "confidence": None, "method": "pp-structure",
                "layout_source": "table-model"}
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:350]) from exc



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


@app.post("/segment")
def segment_grid(photo: Photo):
    """CPU-only OpenCV segmentation, no Paddle runtime or model downloads."""
    try:
        image = decode_photo(photo)
        result = detect_grid(image)
        if not result["cells"]:
            result = detect_text_bands(image)
        return {"engine": "OpenCV grid" if result["cells"] else "OpenCV ink bands", "width": image.shape[1],
                "height": image.shape[0], **result}
    except ImportError:
        raise HTTPException(status_code=503, detail="Install opencv-python-headless")
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=422, detail=str(exc)[:350])



@app.post("/crossout-candidates")
def crossout_candidates(photo: Photo):
    try:
        return detect_crossout_candidates(decode_photo(photo))
    except ImportError:
        raise HTTPException(status_code=503, detail="Install opencv-python-headless")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:350]) from exc


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
        texts = report.get("rec_texts") or []
        scores = report.get("rec_scores") or []
        boxes = report.get("rec_boxes")
        if boxes is None:
            boxes = report.get("rec_polys")
        if boxes is None:
            boxes = []
        height, width = image.shape[:2]
        for index, text in enumerate(texts[:400]):
            if not isinstance(text, str):
                continue
            score = float(scores[index]) if index < len(scores) else None
            bbox = box_to_xyxy(boxes[index], width, height) if index < len(boxes) else None
            lines.append({"text": text[:200],
                          "score": round(score, 4) if score is not None else None,
                          "bbox": bbox})
        # Match recognized fragments to explicitly detected cell boundaries.
        # Unlocated OCR text must never be assigned by visual ordering.
        grid = detect_grid(image)
        matches = []
        for i, box in enumerate(grid["cells"][:800]):
            inside = []
            for line in lines:
                b = line["bbox"]
                if b is None:
                    continue
                cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                if box[0] <= cx <= box[2] and box[1] <= cy <= box[3]:
                    inside.append(line)
            if inside:
                inside.sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))
                matches.append({"cellIndex": i, "bbox": box,
                                "text": " ".join(item["text"] for item in inside)[:250],
                                "confidence": round(min(
                                    (item["score"] or 0) for item in inside), 4),
                                "verified": False})
        return {"engine": "PP-OCRv6 + OpenCV", "lines": lines,
                "recognized_cells": matches[:400], "verified": False}
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:350]) from exc



# A bounded in-memory cache for exact cropped image pixels, not guessed values.
_digit_cell_cache = {}
_digit_cell_cache_lock = threading.RLock()


@app.post("/digit-cells")
def recognize_digit_cells(photo: Photo):
    """Read individual numeric cells locally, preserving uncertainty and geometry.

    This is advisory handwriting OCR; a regex match is NOT verification.
    No cloud calls, maximum 36 cells and bounded cache lifetime.
    """
    try:
        import hashlib
        import cv2
        image = decode_photo(photo)
        geometry = detect_grid(image)
        height, width = image.shape[:2]
        cells = geometry["cells"][:36]
        output = []
        for box in cells:
            x1 = max(0, int(box[0] * width) + 2)
            y1 = max(0, int(box[1] * height) + 2)
            x2 = min(width, int(box[2] * width) - 2)
            y2 = min(height, int(box[3] * height) - 2)
            if x2-x1 < 12 or y2-y1 < 10:
                continue
            crop = image[y1:y2, x1:x2]
            # High resolution and equalization help thin handwritten strokes.
            if crop.shape[0] < 80:
                ratio = min(4, 80 / max(1, crop.shape[0]))
                crop = cv2.resize(crop, None, fx=ratio, fy=ratio,
                                  interpolation=cv2.INTER_CUBIC)
            key = cache_key(crop.tobytes())
            with _digit_cell_cache_lock:
                saved = _digit_cell_cache.get(key)
            if saved is None:
                saved = read_cache(key)
            if saved is not None:
                record = dict(saved)
                record["cached"] = True
            else:
                with _lock:
                    prediction = next(iter(model_ocr().predict(crop)))
                result = prediction.json if hasattr(prediction, "json") else prediction
                if callable(result):
                    result = result()
                result = result.get("res", result)
                texts = [str(t) for t in (result.get("rec_texts") or [])[:8]]
                scores = result.get("rec_scores") or []
                text = " ".join(texts)[:80]
                score = float(min(scores)) if len(scores) else None
                # Numbers are suggestions; mixed symbols are not coerced into digits.
                numeric = bool(re.fullmatch(r"[0-9\s.,-]{1,24}", text))
                record = {"text": text, "score": round(score, 4) if score is not None else None,
                          "numericCandidate": numeric, "verified": False, "cached": False}
                with _digit_cell_cache_lock:
                    if len(_digit_cell_cache) >= 1500:
                        _digit_cell_cache.pop(next(iter(_digit_cell_cache)))
                    _digit_cell_cache[key] = record
                write_cache(key, record)
            output.append({"bbox": box, **record})
        return {"engine": "PP-OCRv6 cell crops", "cells": output,
                "gridDetected": bool(cells), "verified": False,
                "localOnly": True}
    except ImportError:
        raise HTTPException(status_code=503, detail="Install opencv-python-headless and PaddleOCR")
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
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


@app.post("/preprocess")
def perspective_preview(photo: Photo):
    """Conservative OpenCV quadrilateral correction, optional and explicit."""
    try:
        import cv2
        image = decode_photo(photo)
        height, width = image.shape[:2]
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 40, 140)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        selected = None
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
            area = cv2.contourArea(contour)
            if not (.55 <= area / (width * height) <= .99):
                continue
            quad = cv2.approxPolyDP(contour, .02 * cv2.arcLength(contour, True), True)
            if len(quad) == 4:
                selected = quad.reshape(4, 2).astype("float32")
                break
        if selected is None:
            return {"applied": False, "reason": "No safe page boundary"}
        sums = selected.sum(axis=1)
        diffs = np.diff(selected, axis=1).reshape(-1)
        corners = np.array([selected[np.argmin(sums)], selected[np.argmin(diffs)],
                            selected[np.argmax(sums)], selected[np.argmax(diffs)]],
                           dtype="float32")
        target = np.array([[0, 0], [width - 1, 0],
                           [width - 1, height - 1], [0, height - 1]], dtype="float32")
        matrix = cv2.getPerspectiveTransform(corners, target)
        transformed = cv2.warpPerspective(image, matrix, (width, height),
                                          borderMode=cv2.BORDER_REPLICATE)
        ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(transformed, cv2.COLOR_RGB2BGR))
        if not ok:
            raise ValueError("JPEG encoding failed")
        return {"applied": True, "image": "data:image/jpeg;base64," +
                base64.b64encode(jpg.tobytes()).decode("ascii")}
    except ImportError:
        raise HTTPException(status_code=503, detail="Install opencv-python-headless")
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=422, detail=str(exc)[:350]) from exc

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, access_log=False)
