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
