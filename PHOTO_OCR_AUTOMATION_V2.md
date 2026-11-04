# TENSEI · OCR-photo review update (selected 2, 3, 7–11, 14–17, 19, 21–23, 25, 27)

Workflow: **original photograph → quality/geometric evidence → local OCR rows/cells → suspicious cells → explicit cloud recheck → manual confirmation → Excel**.

## Implemented

- **Perspective (2)**: button “Выровнять лист · предпросмотр” asks local OpenCV for a conservative rectification preview. The transformed preview never silently replaces original pixels or its OCR coordinates.
- **Shadow / glare (3)**: page quality analysis reports uneven lighting and clipped highlights; local contrast processing is applied conditionally. Strong glare that hides writing cannot be reliably restored.
- **Handwriting rows and columns (7–8)**: retain local ink-band detection; use repeated, positioned OCR fragments to identify tentative column anchors, and offer explicitly hypothetical cell crop regions for human inspection when ruled grid boundaries are absent. Do not assign cell text by list order.
- **Digits / number plates (9–10)**: automatically attempt individually cropped PP-OCRv6 for pages with reliable ruled grid; normalize Latin/Cyrillic license plate lookalikes against confirmed registry. Candidate values are never automatically substituted for handwritten values.
- **Corrections (11)**: detect possible crossed-out strokes using conservative OpenCV diagonal line search and local text markers. False positives are likely; manual inspection is always needed.
- **Local first (14)**: OpenCV and PP-OCRv6 run before full-page Cloud.ru when local services are available. **Important:** normal cloud transcription is still needed; the local diagnostic candidate alone is not sufficient to automatically commit official transport records.
- **Cell-focused cloud (15)**: the operator can explicitly send a single selected photographed cell to Cloud.ru, with one-request limit and billing warning. Its response is shown separately and cannot overwrite a verified row. Attempts/usage are written to `data/manual-cell-checks.json`.
- **OCR comparison (16)**: available engines, reading differences and uncertainty retained in photo report. Same-model PP-OCRv6 crop/page runs are not independent proof.
- **Persistent cell cache (17)**: local PP-OCRv6 exact-pixel image crop cache survives restarts. Cache key also includes a version identifier. Maximum 1,500 records; cache stores only unverified suggestions.
- **Smart image size (19)**: keep up to 3,000 px for low-detail source images in compact mode; use 2,400 px for clearer pages. This is a heuristic, not an independently verified OCR accuracy improvement.
- **Weights/vehicles/duplicates/structure (21–23, 25)**: existing arithmetic checks and within-file duplicate hints are preserved; registry hints are normalized; cross-photo exact-key duplicate candidates can be shown when date/time/vehicle/weights are present; unmatched detected bands, hypothetical columns and visual correction regions are reported separately. No rows are silently merged or removed.
- **Side-by-side review (27)**: original photo and zoomed crop are shown beside the editable journal; selecting the row updates the displayed image.

## Boundaries and next benchmark

No test in this change proves better handwritten digit accuracy or improved Cloud.ru spend. End-to-end correctness requires representative, manually labeled quarry-journal photos and metrics such as cell/row detection recall, CER/WER, weight errors, and paid Cloud.ru calls per verified page. Cross-source matching without an explicit date should not be treated as certain. Geometric previews do not automatically overwrite original images.

Existing Excel verification rules still require a manually reviewed row and no unresolved issues; raw OCR candidate agreement does not count as human review.
