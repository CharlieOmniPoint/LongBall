"""Validate demo password verifiers without accepting or publishing passwords."""
import base64
import json
import re
from pathlib import Path


def parse_demo_account_verifiers(raw: bytes) -> dict:
    if not raw or len(raw) > 65_536:
        raise ValueError("Demo account verifier file must be nonempty and at most 64KiB.")
    def distinct_fields(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("Duplicate demo verifier fields are not accepted.")
            result[key] = item
        return result
    try:
        value = json.loads(raw, object_pairs_hook=distinct_fields)
    except (UnicodeError, ValueError) as error:
        raise ValueError("Demo account verifier file must contain valid JSON.") from error
    if not isinstance(value, dict) or not {"version", "accounts"} <= set(value) <= {"version", "accounts", "sessionTtlSeconds"} or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Demo account verifier file has unexpected fields or version.")
    ttl = value.get("sessionTtlSeconds", 21_600)
    if type(ttl) is not int or not 600 <= ttl <= 43_200:
        raise ValueError("Demo session lifetime must be 600–43200 seconds.")
    value["sessionTtlSeconds"] = ttl
    accounts = value["accounts"]
    if not isinstance(accounts, list) or not 1 <= len(accounts) <= 32:
        raise ValueError("Demo accounts must be a bounded nonempty list.")
    usernames, account_ids = set(), set()
    for account in accounts:
        if not isinstance(account, dict) or set(account) != {"username", "accountId", "salt", "hash"}:
            raise ValueError("Only username, accountId, salt and verifier hash may be packaged.")
        username, account_id, salt, verifier = (account[key] for key in ["username", "accountId", "salt", "hash"])
        if not isinstance(username, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,63}", username):
            raise ValueError("Demo username format is invalid.")
        if not isinstance(account_id, str) or not re.fullmatch(r"synthetic-account-(?:manager(?:-[2-5])?|admin|club-admin|player-(?:0[1-9]|1[0-3])|spectator)", account_id):
            raise ValueError("Demo account must identify a pre-existing sample account.")
        if username in usernames or account_id in account_ids:
            raise ValueError("Demo usernames and account bindings must be distinct.")
        usernames.add(username)
        account_ids.add(account_id)
        if not isinstance(salt, str) or not re.fullmatch(r"[A-Za-z0-9_-]{22,43}", salt):
            raise ValueError("Demo verifier salt must be canonical base64url.")
        decoded = base64.urlsafe_b64decode(salt + "=" * (-len(salt) % 4))
        if not 16 <= len(decoded) <= 32 or base64.urlsafe_b64encode(decoded).decode().rstrip("=") != salt:
            raise ValueError("Demo verifier salt must encode 16–32 bytes.")
        if not isinstance(verifier, str) or not re.fullmatch(r"[0-9a-f]{64}", verifier):
            raise ValueError("Demo verifier must be a 32-byte lowercase hex digest.")
    return value


def load_demo_account_verifiers(path: Path, root: Path) -> dict:
    selected = path if path.is_absolute() else root / path
    boundary = root / ".local"
    if not selected.resolve().is_relative_to(boundary.resolve()):
        raise ValueError("Select an ignored verifier file under the workspace .local directory.")
    if any(parent.is_symlink() for parent in [selected, *selected.parents]) or not selected.is_file():
        raise ValueError("Demo verifier file must be a regular nonsymlink file.")
    if selected.stat().st_size > 65_536:
        raise ValueError("Demo account verifier file exceeds 64KiB.")
    return parse_demo_account_verifiers(selected.read_bytes())
