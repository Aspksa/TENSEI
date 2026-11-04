"""Optional local geometry test; run after installing numpy and OpenCV."""
import unittest
try:
    import numpy as np
    import cv2
    from grid_geometry import detect_grid, detect_text_bands
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

    def test_unruled_ink_lines_are_candidates_not_confirmed_cells(self):
        photo = np.full((900, 700, 3),255,dtype=np.uint8)
        for y in [140,290,440]:
            cv2.putText(photo, '123 456 789', (40,y), cv2.FONT_HERSHEY_SIMPLEX, 1.8,(0,0,0),5)
        out=detect_text_bands(photo)
        self.assertEqual(out['cells'],[])
        self.assertTrue(out['unverified'])
        self.assertGreaterEqual(len(out['row_boxes']),2)

    def test_plain_page_is_not_mistaken_for_table(self):
        photo = np.full((1200, 900, 3), 255, dtype=np.uint8)
        result = detect_grid(photo)
        self.assertEqual(result["cells"], [])
        self.assertEqual(result["confidence"], 0.0)


if __name__ == "__main__":
    unittest.main()
