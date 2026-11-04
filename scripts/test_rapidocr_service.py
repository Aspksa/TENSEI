import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import rapidocr_service as service


class TestLightOcrService(unittest.TestCase):
    def test_invalid_image_is_rejected_without_model_loading(self):
        for content in ["", "https://outside/image.jpg", "data:image/png;base64,AAAA", "a" * 9000001]:
            with self.assertRaises(ValueError):
                service.decode_image(content)

    def test_normalization_is_advisory_and_bounds_boxes(self):
        fake = SimpleNamespace(txts=["27000", "bad"], scores=[0.9, 0.2],
            boxes=[[[10, 10], [30, 10], [30, 20], [10, 20]],
                   [[90, 90], [20, 20], [10, 10], [10, 10]]])
        out = service.normalize_output(fake, 100, 100)
        self.assertEqual(out["lines"][0]["text"], "27000")
        self.assertEqual(out["lines"][0]["bbox"], [0.1, 0.1, 0.3, 0.2])
        self.assertFalse(out["lines"][0]["verified"])
        self.assertFalse(out["verified"])

    def test_cache_survives_restarts_and_uses_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(service, "cache_root", return_value=Path(directory)):
                original = {"engine": "RapidOCR CPU ONNX", "lines": [{"text": "27300", "verified": False}],
                            "recognized_cells": [], "verified": False, "localOnly": True}
                service.write_result(b"original-jpeg", original)
                value = service.read_result(b"original-jpeg")
                self.assertEqual(value["lines"][0]["text"], "27300")
                self.assertTrue(value["cached"])
                self.assertFalse(value["verified"])
                self.assertIsNone(service.read_result(b"other-jpeg"))


if __name__ == "__main__":
    unittest.main()
