"""Optional local geometry test; run after installing numpy and OpenCV."""
import unittest
try:
    import numpy as np
    import cv2
    from grid_geometry import detect_grid
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, "Local NumPy/OpenCV dependencies are not installed")
class GridGeometryTest(unittest.TestCase):
    def test_ruled_ledger_cell_positions(self):
        photo = np.full((1200, 900, 3), 255, dtype=np.uint8)
        for y in [120, 240, 360, 480, 600, 720]:
            cv2.line(photo, (75, y), (820, y), (0, 0, 0), 3)
        for x in [75, 300, 550, 820]:
            cv2.line(photo, (x, 120), (x, 720), (0, 0, 0), 3)
        result = detect_grid(photo)
        self.assertEqual(len(result["row_boxes"]), 5)
        self.assertEqual(len(result["column_boxes"]), 3)
        self.assertEqual(len(result["cells"]), 15)
        self.assertTrue(all(0 <= v <= 1 for cell in result["cells"] for v in cell))

    def test_plain_page_is_not_mistaken_for_table(self):
        photo = np.full((1200, 900, 3), 255, dtype=np.uint8)
        result = detect_grid(photo)
        self.assertEqual(result["cells"], [])
        self.assertEqual(result["confidence"], 0.0)


if __name__ == "__main__":
    unittest.main()
