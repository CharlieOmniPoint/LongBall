"""Exercise real Git publication, including a newer remote and divergent history."""
import base64
import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path

PUBLISH = Path(__file__).resolve().parents[1] / "infra/cloud-preview/publish-source.sh"


class PublicationTests(unittest.TestCase):
    def test_verified_bundle_preserves_newer_and_divergent_remote(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote, source, runner = [root / name for name in ("remote", "source", "runner")]

            def git(path, *args):
                return subprocess.check_output(["git", "-C", str(path), *args], text=True, stderr=subprocess.DEVNULL).strip()

            def identity(path):
                git(path, "config", "user.name", "Fictional publication test")
                git(path, "config", "user.email", "publication@example.invalid")

            subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
            subprocess.run(["git", "init", "-b", "main", str(source)], check=True, capture_output=True)
            identity(source)
            (source / "file").write_text("base")
            git(source, "add", ".")
            git(source, "commit", "-m", "base")
            git(source, "remote", "add", "origin", str(remote))
            git(source, "push", "origin", "main")
            git(source, "checkout", "-b", "dev/test")
            (source / "file").write_text("candidate")
            git(source, "commit", "-am", "candidate")
            candidate = git(source, "rev-parse", "HEAD")
            bundle = root / "source.bundle"
            git(source, "bundle", "create", str(bundle), "dev/test", "^main")
            subprocess.run(["git", "clone", "-b", "main", str(remote), str(runner)], check=True, capture_output=True)
            identity(runner)
            metadata = root / "metadata"
            metadata.mkdir()
            raw = bundle.read_bytes()
            (metadata / "source.bundle.base64").write_bytes(base64.b64encode(raw))
            (metadata / "source.bundle.sha256").write_text(hashlib.sha256(raw).hexdigest())
            (metadata / "source-branch.txt").write_text("dev/test")
            (metadata / "source-head.txt").write_text(candidate)

            def publish():
                return subprocess.run(["bash", str(PUBLISH), str(metadata), str(root / "decoded.bundle")], cwd=runner, capture_output=True)

            self.assertEqual(publish().returncode, 0)
            self.assertEqual(git(remote, "rev-parse", "dev/test"), candidate)
            self.assertEqual(publish().returncode, 0)
            (source / "file").write_text("newer accepted changes")
            git(source, "commit", "-am", "newer")
            git(source, "push", "origin", "dev/test")
            newer = git(source, "rev-parse", "HEAD")
            self.assertEqual(publish().returncode, 0)
            self.assertEqual(git(remote, "rev-parse", "dev/test"), newer)

            # Build an independently diverged candidate and prove it cannot replace newer history.
            git(source, "reset", "--hard", "main")
            (source / "file").write_text("divergent")
            git(source, "commit", "-am", "divergent")
            git(source, "bundle", "create", str(bundle), "dev/test", "^main")
            raw = bundle.read_bytes()
            (metadata / "source.bundle.base64").write_bytes(base64.b64encode(raw))
            (metadata / "source.bundle.sha256").write_text(hashlib.sha256(raw).hexdigest())
            (metadata / "source-head.txt").write_text(git(source, "rev-parse", "HEAD"))
            self.assertNotEqual(publish().returncode, 0)
            self.assertEqual(git(remote, "rev-parse", "dev/test"), newer)
            (metadata / "source.bundle.sha256").write_text("0" * 64)
            self.assertNotEqual(publish().returncode, 0)
            self.assertEqual(git(remote, "rev-parse", "dev/test"), newer)


if __name__ == "__main__":
    unittest.main()
