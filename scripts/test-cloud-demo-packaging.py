"""Exercise verifier-only packaging boundaries without building an application."""
import base64
import contextlib
import copy
import io
import json
import runpy
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from demo_account_verifiers import load_demo_account_verifiers, parse_demo_account_verifiers


def fixture():
    return {"version": 1, "sessionTtlSeconds": 21600, "accounts": [{
        "username": "unit.manager", "accountId": "synthetic-account-manager-2",
        "salt": base64.urlsafe_b64encode(bytes(range(16))).decode().rstrip("="), "hash": "ab" * 32,
    }]}


class VerifierPackagingTests(unittest.TestCase):
    def parse(self, value):
        return parse_demo_account_verifiers(json.dumps(value).encode())

    def test_accepts_only_normalized_precomputed_verifiers_and_explicitly_defaults_lifetime(self):
        value = fixture()
        self.assertEqual(self.parse(value), value)
        del value["sessionTtlSeconds"]
        self.assertEqual(self.parse(value)["sessionTtlSeconds"], 21600)
        for ttl in [600, 43200]:
            value["sessionTtlSeconds"] = ttl
            self.assertEqual(self.parse(value)["sessionTtlSeconds"], ttl)

    def test_rejects_plaintext_or_unknown_configuration_fields(self):
        for target, field in [("top", "password"), ("account", "passcode"), ("account", "role"), ("top", "secret")]:
            value = fixture()
            (value if target == "top" else value["accounts"][0])[field] = "must-never-be-packaged"
            with self.assertRaises(ValueError):
                self.parse(value)

    def test_accepts_preexisting_club_admin_without_authority_fields(self):
        value = fixture()
        value["accounts"][0]["accountId"] = "synthetic-account-club-admin"
        self.assertEqual(self.parse(value)["accounts"][0]["accountId"], "synthetic-account-club-admin")

    def test_rejects_unknown_duplicate_and_unbounded_accounts(self):
        for mutation in [
            lambda value: value.update(version=True),
            lambda value: value.update(sessionTtlSeconds=True),
            lambda value: value.update(sessionTtlSeconds=599),
            lambda value: value.update(sessionTtlSeconds=43201),
            lambda value: value.update(accounts=[]),
            lambda value: value.update(accounts=value["accounts"] * 33),
            lambda value: value["accounts"].append(copy.deepcopy(value["accounts"][0])),
            lambda value: value["accounts"][0].update(accountId="real-account"),
            lambda value: value["accounts"][0].update(accountId="synthetic-account-other-manager"),
            lambda value: value["accounts"][0].update(username="Bad Account"),
            lambda value: value["accounts"][0].update(hash="not-a-verifier"),
            lambda value: value["accounts"][0].update(salt="not-a-verifier"),
        ]:
            value = fixture()
            mutation(value)
            with self.assertRaises(ValueError):
                self.parse(value)
        with self.assertRaises(ValueError):
            parse_demo_account_verifiers(b'{"version":1,"version":1,"accounts":[]}')
        with self.assertRaises(ValueError):
            parse_demo_account_verifiers(b" " * 65537)

    def test_rejects_noncanonical_salt_aliases(self):
        value = fixture()
        # A 16-byte salt has unused low bits in its final base64url character.
        value["accounts"][0]["salt"] = value["accounts"][0]["salt"][:-1] + "x"
        with self.assertRaises(ValueError):
            self.parse(value)

    def test_reads_only_regular_ignored_local_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local = root / ".local"
            local.mkdir()
            config = local / "verifiers.json"
            config.write_text(json.dumps(fixture()))
            self.assertEqual(load_demo_account_verifiers(config, root), fixture())
            outside = root / "credentials.json"
            outside.write_text(json.dumps(fixture()))
            with self.assertRaises(ValueError):
                load_demo_account_verifiers(outside, root)
            alias = local / "alias.json"
            alias.symlink_to(config)
            with self.assertRaises(ValueError):
                load_demo_account_verifiers(alias, root)


class PreviewPayloadTests(unittest.TestCase):
    def test_payload_and_both_browser_builds_receive_only_the_explicit_verifier_profile(self):
        repository = Path(__file__).resolve().parents[1]
        for enabled in [False, True]:
            with self.subTest(enabled=enabled), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                script = root / "scripts/package-cloud-preview.py"
                script.parent.mkdir()
                shutil.copyfile(repository / "scripts/package-cloud-preview.py", script)
                # Use real transport templates; application compilation and Git's
                # committed-only bundle are stubbed to keep this a bounded test.
                for prefix in ["infra/cloud-preview", "infra/runtime", "infra/ci"]:
                    for source in (repository / prefix).rglob("*"):
                        if source.is_file() and source.suffix not in [".pyc"] and "node_modules" not in source.parts:
                            target = root / source.relative_to(repository)
                            target.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copyfile(source, target)
                local = root / ".local"
                local.mkdir()
                verifier = local / "verifiers.json"
                verifier.write_text(json.dumps(fixture()))
                (local / "credentials.json").write_text('{"passcode":"chat-only-unit-passphrase"}')
                builds = []

                def git(args, **_kwargs):
                    command = args[1:]
                    if command == ["status", "--porcelain"]:
                        return ""
                    if command == ["branch", "--show-current"]:
                        return "dev/longball-m0-journey"
                    if command == ["rev-parse", "HEAD"]:
                        return "a" * 40
                    self.fail(f"Unexpected Git read: {command}")

                def run(args, **kwargs):
                    if args[:3] == ["git", "bundle", "create"]:
                        Path(args[3]).write_bytes(b"committed-source-only-unit-bundle")
                    elif "expo" in args:
                        builds.append(kwargs["env"])
                        output = Path(args[args.index("--output-dir") + 1])
                        output.mkdir(parents=True)
                        (output / "index.html").write_text("<div>demo-login-build</div>")
                    elif args == ["pnpm", "build:api"]:
                        output = Path(kwargs["env"]["LONGBALL_API_BUILD_DIRECTORY"])
                        output.mkdir(parents=True)
                        (output / "api.mjs").write_text("// compiled API fixture")
                    else:
                        self.fail(f"Unexpected build command: {args}")

                argv = [str(script), "--with-pages"] + (["--demo-accounts-file", str(verifier)] if enabled else [])
                with patch.object(sys, "argv", argv), patch("subprocess.check_output", side_effect=git), patch("subprocess.run", side_effect=run), patch.dict("os.environ", {"EXPO_PUBLIC_DEMO_ACCOUNT_LOGIN": "inherited-value"}), contextlib.redirect_stdout(io.StringIO()):
                    runpy.run_path(str(script), run_name="__main__")
                payload_text = (local / "cloud-preview-payload.json").read_text()
                payload = {item["path"]: item["content"] for item in json.loads(payload_text)}
                self.assertNotIn("chat-only-unit-passphrase", payload_text)
                self.assertEqual([build["EXPO_PUBLIC_DEMO_ACCOUNT_LOGIN"] for build in builds], [str(int(enabled))] * 2)
                self.assertEqual(json.loads(payload["preview/native-build-request.txt"])["demo_account_login"], enabled)
                self.assertEqual("preview/demo-accounts.json" in payload, enabled)
                self.assertEqual("preview/demo-accounts.sha256" in payload, enabled)
                if enabled:
                    self.assertEqual(json.loads(payload["preview/demo-accounts.json"]), fixture())


if __name__ == "__main__":
    unittest.main()
