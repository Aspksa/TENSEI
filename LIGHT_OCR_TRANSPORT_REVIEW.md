# TENSEI: lightweight OCR, photo ↔ Legion CSV review

This update selects tasks 1, 5, 7–12, 14, 16–17, 22–26, 28 and 31, with additions that preserve the existing Excel and CSV contracts.

## CPU OCR

RapidOCR is **optional**; do not install it on a laptop that does not need local OCR. The core TENSEI launcher and Node.js dependencies stay unchanged. To install on compatible Windows x64 with Python 3.11, run `TENSEI_RapidOCR_CPU.bat`. It creates a separate `.rapidocr-venv`, installs `rapidocr` and `onnxruntime`, then starts `127.0.0.1:8767`. A separate console must remain open during local OCR use. If installing manually:

```powershell
py -3.11 -m venv .rapidocr-venv
.\.rapidocr-venv\Scripts\python -m pip install -r scripts/rapidocr-requirements.txt
.\.rapidocr-venv\Scripts\python scripts/rapidocr_service.py
```

The service is single-threaded, uses one CPU worker, initializes its model only on a real OCR request, and by default **releases the model after the request** (`TENSEI_RAPIDOCR_KEEP_WARM=0`). This trades some startup latency for low idle memory consumption. Exact JPEG reads are cached on disk (engine-versioned key, max 500 entries). The old PP-OCRv6 persistent cell cache remains available separately. No model or package is downloaded by normal `TENSEI.bat` startup.

TENSEI first checks RapidOCR health quickly; only if it is available does the auto pipeline request its local text hints. Otherwise, the existing PaddleOCR path is retained. Cloud.ru still handles the main authoritative extraction pipeline; the local hints do not prove that handwriting was recognized correctly.

For a selected cell, **RapidOCR — проверить наклон цифр** returns 0°, −8°, +8° suggestions. This is on-demand only, up to three model runs, and does not auto-apply any value. Cloud.ru one-cell recheck is a separate explicitly paid option.

## Review and structure

Existing grid / ink-band detection is retained. Header and column candidates, missing rows, possible corrections/cross-outs, arithmetic of weights, plate registry and duplicates remain diagnostic. A photo's **optional trip date** is editable in the review table. Missing dates are not inferred from filename or from the current day; such entries remain unmatched in strict CSV reconciliation. The photo Excel has `Дата рейса` added at the **end**, preserving the original first 13 columns. Old Legion XLSX/ZIP structures are not altered.

## Compare a photo draft with Legion CSV

After uploading a CSV in Legion, click **Сверить фото и CSV**. This calls `GET /api/transport/reconcile?importId=<UUID>` on localhost and returns an evidence-only, read-only combined ledger: rows from the saved photo draft and the selected existing CSV import. Exact matching requires date, time, normalized license plate and net weight. A shared date/time/plate with different net is a **weight mismatch**; missing date/time/plate/net means **needs-review**; repeated candidate CSV rows are **duplicates**. The API returns differences, unresolved CSV rows and totals. A matching record is only a candidate, never human-verified correctness. No source is merged, modified or deleted.

## Validation and scope

Node/Python tests cover the optional local sidecar without downloading weights; Windows and Linux CI remain mandatory. OCR accuracy cannot be claimed improved without a real annotated set of photographed weighbridge journals. A trained Russian handwritten-number model is **not** bundled, and neither exact matching nor arithmetic verifies the handwritten source.
