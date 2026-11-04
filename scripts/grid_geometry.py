"""Conservative geometry detection for ruled handwritten transport journals.

This module identifies visible horizontal/vertical ruling lines using OpenCV.
It never guesses a cell position from OCR text order. All coordinates are
normalized to the actual input image. Poor grid evidence returns no cells.
"""
import numpy as np


def _positions(mask, axis, min_span=2):
    """Midpoint of runs of active rows or columns."""
    activity = np.asarray(mask, dtype=bool)
    indices = np.flatnonzero(activity)
    if not len(indices):
        return []
    groups = np.split(indices, np.flatnonzero(np.diff(indices) > 1) + 1)
    return [int(round((int(g[0]) + int(g[-1])) / 2))
            for g in groups if len(g) >= min_span]


def detect_grid(image):
    import cv2

    if image is None or image.ndim != 3:
        raise ValueError("Expected RGB input image")
    height, width = image.shape[:2]
    if min(height, width) < 200:
        return {"cells": [], "row_boxes": [], "column_boxes": [],
                "confidence": 0.0, "method": "opencv-ruling"}
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY_INV, 31, 11)
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN,
                  cv2.getStructuringElement(cv2.MORPH_RECT,
                                             (max(45, width // 14), 1)))
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN,
                cv2.getStructuringElement(cv2.MORPH_RECT,
                                           (1, max(45, height // 15))))
    # Only lines spanning most of the page produce reliable table coordinates.
    h_profiles = np.count_nonzero(horizontal, axis=1) >= width * 0.52
    v_profiles = np.count_nonzero(vertical, axis=0) >= height * 0.35
    y_lines = _positions(h_profiles, axis=0, min_span=1)
    x_lines = _positions(v_profiles, axis=1, min_span=1)
    # Remove repeated line detections and tiny intervals.
    def merge_close(values, separation):
        kept = []
        for value in values:
            if kept and value - kept[-1] < separation:
                kept[-1] = (kept[-1] + value) // 2
            else:
                kept.append(value)
        return kept
    y_lines = merge_close(y_lines, max(6, height // 160))
    x_lines = merge_close(x_lines, max(6, width // 120))
    if len(y_lines) < 3 or len(x_lines) < 3:
        return {"cells": [], "row_boxes": [], "column_boxes": [],
                "confidence": 0.0, "method": "opencv-ruling",
                "horizontal_lines": len(y_lines), "vertical_lines": len(x_lines)}
    # Never extrapolate non-observed page lines.
    regions = []
    for top, bottom in zip(y_lines, y_lines[1:]):
        if bottom - top < max(10, height * 0.008):
            continue
        regions.append([0.0, round(top / height, 6), 1.0,
                        round(bottom / height, 6)])
    columns = []
    for left, right in zip(x_lines, x_lines[1:]):
        if right - left < max(10, width * 0.015):
            continue
        columns.append([round(left / width, 6), 0.0,
                        round(right / width, 6), 1.0])
    if not regions or not columns or len(regions) > 150 or len(columns) > 40:
        return {"cells": [], "row_boxes": [], "column_boxes": [],
                "confidence": 0.0, "method": "opencv-ruling"}
    cells = [
        [col[0], row[1], col[2], row[3]]
        for row in regions for col in columns
    ][:1200]
    # This score describes line geometry only, not correctness of handwritten OCR.
    confidence = round(min(.95, .35 + min(len(regions), 25) * .012 +
                            min(len(columns), 12) * .025), 3)
    return {"cells": cells, "row_boxes": regions,
            "column_boxes": columns, "confidence": confidence,
            "method": "opencv-ruling",
            "horizontal_lines": len(y_lines), "vertical_lines": len(x_lines)}


def detect_text_bands(image):
    """Find tentative text-row bands without ruled lines; never claim cells."""
    import cv2
    if image is None or image.ndim != 3:
        raise ValueError("Expected RGB image")
    height, width = image.shape[:2]
    if min(height, width) < 200:
        return {"cells": [], "row_boxes": [], "column_boxes": [],
                "method": "ink-projection", "confidence": 0.0}
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    mask = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, 31, 13)
    # Suppress thin long horizontal rules before row projection.
    long_lines = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
                  cv2.getStructuringElement(cv2.MORPH_RECT, (max(45, width // 8), 1)))
    ink = cv2.subtract(mask, long_lines)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(8, width // 85), 2))
    joined = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, kernel)
    density = np.count_nonzero(joined, axis=1) / width
    active = np.flatnonzero((density > .012) & (density < .72))
    if len(active) == 0:
        return {"cells": [], "row_boxes": [], "column_boxes": [],
                "method": "ink-projection", "confidence": 0.0}
    bands = np.split(active, np.flatnonzero(np.diff(active) > max(2, height // 330)) + 1)
    result = []
    for b in bands:
        top, bottom = int(b[0]), int(b[-1])
        if bottom - top < max(7, height // 210) or bottom - top > height * .10:
            continue
        y1, y2 = max(0, top-3)/height, min(height, bottom+4)/height
        result.append([0.0, round(y1, 6), 1.0, round(y2, 6)])
    return {"cells": [], "row_boxes": result[:100], "column_boxes": [],
            "method": "ink-projection",
            "confidence": None, "unverified": True}


def detect_crossout_candidates(image):
    """Advisory diagonal-over-text candidates, not a confident correction detector."""
    import cv2
    if image is None or image.ndim != 3:
        raise ValueError("Expected RGB image")
    h, w = image.shape[:2]
    if min(h, w) < 200:
        return {"candidates": [], "verified": False}
    lines = detect_text_bands(image).get("row_boxes", [])[:100]
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 55, 145)
    result = []
    for band in lines:
        y1 = max(0, int(band[1] * h))
        y2 = min(h, int(band[3] * h))
        if y2-y1 < 10:
            continue
        guesses = cv2.HoughLinesP(edges[y1:y2], 1, np.pi/180, threshold=25,
                                  minLineLength=max(20, w//55), maxLineGap=5)
        if guesses is None:
            continue
        for segment in guesses[:150]:
            x1, a, x2, b = (int(x) for x in segment[0])
            dx, dy = abs(x2-x1), abs(b-a)
            if dx < 20 or dx > w*.38 or dy < 7 or not (.15 <= dy/max(dx,1) <= .9):
                continue
            bbox = [max(0,(min(x1,x2)-4)/w),max(0,(y1+min(a,b)-4)/h),
                    min(1,(max(x1,x2)+4)/w),min(1,(y1+max(a,b)+4)/h)]
            result.append({"bbox": bbox, "reason": "diagonal-stroke-in-text-band",
                           "verified": False})
            if len(result)>=35:
                break
        if len(result)>=35:
            break
    return {"candidates": result, "verified": False,
            "note": "Диагональные штрихи могут быть обычным почерком; сверяйте вручную"}
