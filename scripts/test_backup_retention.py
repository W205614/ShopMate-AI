import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from retain_latest_backup import choose_backups
from windows_recycle import checked_path


class RetentionSafetyTests(unittest.TestCase):
    def test_missing_or_invalid_latest_pair_preserves_previous_valid_recovery_point(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            old = directory / "shopmate-current-old.sqlite"
            incomplete = directory / "shopmate-daily-new.sqlite"
            old.write_bytes(b"synthetic old")
            Path(str(old) + ".manifest.json").write_text("{}")
            incomplete.write_bytes(b"incomplete new")
            result = SimpleNamespace(returncode=0, stdout=json.dumps({"reason": "manual", "createdAt": "2026-01-01T00:00:00Z", "sha256": "synthetic"}))
            with patch("retain_latest_backup.subprocess.run", return_value=result):
                valid, retained = choose_backups(directory, directory, "node")
            self.assertEqual([item["path"] for item in valid], [str(old.resolve())])
            self.assertEqual([item["path"] for item in retained], [str(incomplete.resolve())])
            self.assertTrue(old.exists())
            self.assertTrue(incomplete.exists())

    def test_failed_verification_never_selects_a_recovery_point(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            backup = directory / "shopmate-current.sqlite"
            backup.write_bytes(b"invalid")
            Path(str(backup) + ".manifest.json").write_text("{}")
            with patch("retain_latest_backup.subprocess.run", return_value=SimpleNamespace(returncode=1)):
                with self.assertRaisesRegex(ValueError, "No fully verified backup"):
                    choose_backups(directory, directory, "node")
            self.assertTrue(backup.exists())

    def test_unknown_backup_reasons_remain_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            backup = directory / "shopmate-foreign.sqlite"
            backup.write_bytes(b"unrecognized")
            Path(str(backup) + ".manifest.json").write_text("{}")
            result = SimpleNamespace(returncode=0, stdout=json.dumps({"reason": "unknown"}))
            with patch("retain_latest_backup.subprocess.run", return_value=result):
                with self.assertRaises(ValueError):
                    choose_backups(directory, directory, "node")
            self.assertTrue(backup.exists())

    def test_root_and_paths_outside_the_allowed_directory_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            allowed = directory / "backups"
            allowed.mkdir()
            outside = directory / "not-a-backup"
            outside.write_bytes(b"protected")
            for path in [outside, allowed]:
                with self.assertRaises(ValueError):
                    checked_path(path, allowed)
            self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
