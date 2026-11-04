import tempfile
import unittest
from pathlib import Path
from cell_cache import cache_key, read_cache, write_cache


class TestPersistentCellCache(unittest.TestCase):
    def test_exact_bytes_versioned_and_never_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            key = cache_key(b"raw pixel bytes")
            changed = cache_key(b"raw pixel bytes.")
            self.assertNotEqual(key, changed)
            self.assertNotEqual(key, cache_key(b"raw pixel bytes", version="other engine"))
            self.assertIsNone(read_cache(key, directory))
            self.assertTrue(write_cache(key, {"text": "18000", "score": .8,
                                             "numericCandidate": True, "verified": True}, directory))
            loaded = read_cache(key, directory)
            self.assertEqual(loaded["text"], "18000")
            self.assertFalse(loaded["verified"])
            self.assertIsNone(read_cache(changed, directory))
            self.assertIsNone(read_cache("../escape", directory))

    def test_prunes_cache_files(self):
        with tempfile.TemporaryDirectory() as directory:
            for i in range(5):
                key = cache_key(f"{i}".encode())
                self.assertTrue(write_cache(key, {"text": str(i)}, directory, limit=2))
            self.assertLessEqual(len(list(Path(directory).glob("*.json"))), 2)


if __name__ == "__main__":
    unittest.main()
