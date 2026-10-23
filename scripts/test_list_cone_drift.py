"""Real-Git checks for the private read-only cone inventory."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("list-cone-drift.py")


class ConeInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ao-cone-inventory-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        for name in ["inside/seed", "outside/seed"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"seed")
        self.git("add", ".")
        self.git("commit", "-m", "seed")
        self.git("sparse-checkout", "set", "--cone", "inside")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.DEVNULL)

    def test_hashes_paths_and_read_only(self):
        names = ["outside/有 空格.txt", "outside/换\n行.txt", "outside/.ignored"]
        for name in names:
            target = self.root / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(b"canary\0data")
        (self.root / ".gitignore").write_text("outside/.ignored\n")
        before = self.git("status", "--porcelain=v2", "-z", "--untracked-files=all")
        result = subprocess.check_output(["python3", str(SCRIPT), str(self.root)])
        rows = [json.loads(line) for line in result.splitlines()]
        self.assertEqual({r["path"] for r in rows}, set(names))
        self.assertTrue(all(r["sha256"] == hashlib.sha256(b"canary\0data").hexdigest() for r in rows))
        self.assertEqual(before, self.git("status", "--porcelain=v2", "-z", "--untracked-files=all"))

    @unittest.skipIf(os.geteuid() == 0, "root can traverse mode-000 directories")
    def test_unreadable_directory_fails(self):
        blocked = self.root / "blocked"
        blocked.mkdir()
        (blocked / "private").write_bytes(b"must not silently disappear")
        blocked.chmod(0)
        try:
            result = subprocess.run(["python3", str(SCRIPT), str(self.root)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"PermissionError", result.stderr)
        finally:
            blocked.chmod(0o700)


if __name__ == "__main__":
    unittest.main()
