"""Validate every PCP sample and reject every deliberately bad sample (mirror of the TS tests)."""
from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import shutil
from pathlib import Path

import pytest

from pcp_schemas import PcpValidator, default_schema_dir
from pcp_compat import SchemaSet, fields_only_in

REPO = default_schema_dir().parent
SAMPLES = REPO / "samples"
# Every samples/<dir> except invalid/ holds valid sessions (camfrog, discord, twitch, bridge, ...).
VALID_DIRS = sorted(d for d in SAMPLES.iterdir() if d.is_dir() and d.name != "invalid")
VALID_FILES = sorted(p for d in VALID_DIRS for p in d.glob("*.json"))
BAD_FILES = sorted((SAMPLES / "invalid").glob("*.json"))

validator = PcpValidator()


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _id(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def test_there_are_samples():
    assert len(VALID_FILES) >= 10
    assert len(BAD_FILES) >= 10


@pytest.mark.parametrize("path", VALID_FILES, ids=_id)
def test_valid_sample(path: Path):
    sample = _load(path)
    assert sample.get("description"), "sample needs a description"
    assert sample.get("frames"), "sample needs frames"
    for i, entry in enumerate(sample["frames"]):
        assert entry["dir"] in ("c2r", "r2c"), f"frame {i}: dir"
        frame = entry["frame"]
        result = validator.validate_frame(frame)
        why = "; ".join(f"{e.path} {e.message}" for e in result.errors)
        assert result.valid, f"frame {i} ({frame.get('op')} {frame.get('type', '')}) invalid: {why}"
        assert result.known, f"frame {i} uses a type not in index.json: {frame.get('type')}"


@pytest.mark.parametrize("path", BAD_FILES, ids=_id)
def test_invalid_sample(path: Path):
    bad = _load(path)
    result = validator.validate_frame(bad["frame"])
    assert not result.valid, f"expected rejection: {bad['description']}"
    paths = [e.path for e in result.errors]
    assert any(p.startswith(bad["expect_path"]) for p in paths), (
        f"expected an error at {bad['expect_path']}, got: {paths}"
    )


def test_every_type_has_a_sample():
    seen = set()
    for path in VALID_FILES:
        for entry in _load(path)["frames"]:
            f = entry["frame"]
            seen.add(f"{f['op']}:{f['type']}" if f["op"] in ("event", "action") else f"op:{f['op']}")
    wanted = (
        [f"event:{t}" for t in validator.index["events"]]
        + [f"action:{t}" for t in validator.index["actions"]]
        + [f"op:{o}" for o in ("hello", "welcome", "result", "ack", "ping", "pong", "flow", "bye")]
    )
    missing = [k for k in wanted if k not in seen]
    assert not missing, f"types without a sample: {missing}"


def test_results_answer_actions_in_same_file():
    for path in VALID_FILES:
        frames = [e["frame"] for e in _load(path)["frames"]]
        actions = {f["id"]: f["type"] for f in frames if f["op"] == "action"}
        for f in frames:
            if f["op"] == "result":
                assert actions.get(f["ref"]) == f["type"], f"{path.name}: result {f['id']} ref={f['ref']}"


def test_type_names_have_no_underscores():
    import re
    names = list(validator.index["events"]) + list(validator.index["actions"])
    assert [n for n in names if not re.fullmatch(r"[a-z]+(\.[a-z]+)*", n)] == []


def _minor(version: str) -> int:
    major, minor = (int(x) for x in version.split("."))
    assert major == 1, f"unexpected major in {version}"
    return minor


def test_since_marks_1_1_types():
    assert validator.index["pcp"] == "1.1"
    entries = list(validator.index["events"].items()) + list(validator.index["actions"].items())
    for name, entry in entries:
        if "since" in entry:
            assert 1 <= _minor(entry["since"]) <= _minor(validator.index["pcp"]), f"{name}: since {entry['since']}"
    added = [n for n, e in entries if e.get("since") == "1.1"]
    assert len(added) >= 25, f"only {len(added)} types marked since 1.1"
    for t in ("message", "send", "reaction", "mic.grab", "audio.play"):
        entry = validator.index["events"].get(t) or validator.index["actions"].get(t)
        assert "since" not in entry, f"{t} is a 1.0 type"


def test_1_0_sessions_use_only_1_0_types():
    checked = 0
    for path in VALID_FILES:
        negotiated = None
        for entry in _load(path)["frames"]:
            f = entry["frame"]
            if f["op"] == "welcome":
                negotiated = _minor(f["data"]["pcp"])
            if negotiated is None or f["op"] not in ("event", "action", "result"):
                continue
            reg = validator.index["events"] if f["op"] == "event" else validator.index["actions"]
            since = _minor(reg[f["type"]]["since"]) if "since" in reg.get(f["type"], {}) else 0
            assert since <= negotiated, f"{path.name}: {f['op']} {f['type']} (since 1.{since}) in a 1.{negotiated} session"
            checked += 1
    assert checked > 0, "no sample negotiates a version"


def test_validate_data():
    assert validator.validate_data("event", "mic.grab", {"user": {"id": "someone"}}).valid
    assert not validator.validate_data("event", "mic.grab", {}).valid
    assert validator.validate_data("result", "sticker.send", {"posted": None}).valid
    assert not validator.validate_data("action", "nope", {}).known
    assert validator.validate_data("result", "interaction.followup", {"message_ids": ["m-1"]}).valid
    assert not validator.validate_data("event", "room.state", {"full": True}).valid


def test_unknown_future_type_is_forward_compatible():
    result = validator.validate_frame({
        "op": "event", "id": "evt-future-1", "ts": "2026-10-05T18:00:00.000Z", "seq": 7,
        "type": "poll.vote", "connector": "cf-main", "scope": {"platform": "camfrog"},
        "data": {"anything": True}, "new_field": 1,
    })
    assert result.valid
    assert not result.known


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_generated_dispatch_up_to_date():
    subprocess.run(["node", str(REPO / "scripts" / "gen-dispatch.mjs"), "--check"], check=True)


# The frozen PCP 1.0 schemas (git 501e5b0), for the field-level 1.0 compatibility check.
COMPAT_10 = REPO / "compat" / "pcp-1.0" / "schemas"
v10 = PcpValidator(COMPAT_10)
set10 = SchemaSet(COMPAT_10)
set11 = SchemaSet(default_schema_dir())


def test_1_0_sessions_carry_no_1_1_fields_and_validate_as_1_0():
    assert v10.index["pcp"] == "1.0"
    checked = 0
    for path in VALID_FILES:
        negotiated = None
        for i, entry in enumerate(_load(path)["frames"]):
            f = entry["frame"]
            if f["op"] == "hello":
                negotiated = None
            if f["op"] == "welcome":
                negotiated = _minor(f["data"]["pcp"])
            if negotiated != 0:
                continue
            where = f"{path.name} frame {i} ({f['op']} {f.get('type', '')})"
            r = v10.validate_frame(f)
            assert r.valid and r.known, f"{where}: not valid 1.0: {[(e.path, e.message) for e in r.errors]}"
            assert fields_only_in(set11, set10, f) == [], f"{where} carries 1.1 fields"
            checked += 1
    assert checked >= 5, f"only {checked} frames of 1.0 sessions checked"


def test_the_1_1_field_check_finds_fields_elements_and_types():
    send = {
        "op": "action", "id": "r-1", "ts": "2026-10-18T18:00:00.000Z", "type": "send",
        "scope": {"platform": "discord", "room": {"id": "1100000000000000010"}},
        "data": {"text": "hi"},
    }
    assert fields_only_in(set11, set10, send) == []
    assert fields_only_in(set11, set10, {**send, "target": "native"}) == ["/target"]
    assert fields_only_in(set11, set10, {**send, "data": {"text": "hi", "relay": {"msg_id": "m", "binding": "b"}}}) == ["/data/relay"]
    assert fields_only_in(
        set11, set10, {**send, "data": {"text": "x", "content": [{"type": "code_block", "text": "x", "lang": "js"}]}}
    ) == ["/data/content/0/text", "/data/content/0/lang"]
    result = {
        "op": "result", "id": "c-1", "ts": "2026-10-18T18:00:00.000Z", "seq": 1, "ref": "r-1", "type": "send",
        "ok": True, "data": {"message_ids": ["m-1"], "parts": 1, "t": {"wait_ms": 1, "send_ms": 2}},
    }
    assert fields_only_in(set11, set10, result) == ["/data/t"]
    msg = {
        "op": "event", "id": "c-2", "ts": "2026-10-18T18:00:00.000Z", "seq": 2, "type": "message", "connector": "dc",
        "scope": {"platform": "discord", "room": {"id": "1"}},
        "data": {"user": {"id": "1", "anonymous": True}, "text": "hi", "ext": {"discord": {"anything": 1}}},
    }
    assert fields_only_in(set11, set10, msg) == ["/data/user/anonymous"]


def test_every_1_1_type_has_an_invalid_sample():
    seen = set()
    for path in BAD_FILES:
        f = _load(path)["frame"]
        if f.get("op") == "event":
            seen.add(f"event:{f['type']}")
        if f.get("op") in ("action", "result"):
            seen.add(f"action:{f['type']}")
    wanted = [f"event:{t}" for t, e in validator.index["events"].items() if e.get("since") == "1.1"] + [
        f"action:{t}" for t, e in validator.index["actions"].items() if e.get("since") == "1.1"
    ]
    missing = [k for k in wanted if k not in seen]
    assert not missing, f"1.1 types without an invalid sample: {missing}"


def test_relay_parts_are_numbered_1_to_of():
    parts = 0
    for path in VALID_FILES:
        for entry in _load(path)["frames"]:
            f = entry["frame"]
            part = ((f.get("data") or {}).get("relay") or {}).get("part") if f["op"] == "action" else None
            if not part:
                continue
            assert 1 <= part["n"] <= part["of"], f"{path.name} {f['id']}: part {part['n']} of {part['of']}"
            parts += 1
    assert parts > 0, "no sample relays a split line"


def test_message_reaction_only_when_subscribed_by_name():
    for path in VALID_FILES:
        subscribe = None
        welcomed = False
        for entry in _load(path)["frames"]:
            f = entry["frame"]
            if f["op"] == "hello":
                welcomed = False
            if f["op"] == "welcome":
                welcomed = True
                subscribe = f["data"].get("subscribe")
            if not welcomed or f["op"] != "event":
                continue
            wants_new = subscribe is not None and "message.reaction" in subscribe
            wants_old = subscribe is None or "reaction" in subscribe
            if f["type"] == "message.reaction":
                assert wants_new, f"{path.name} {f['id']}: message.reaction without welcome.subscribe naming it"
            if f["type"] == "reaction":
                assert wants_old, f"{path.name} {f['id']}: reaction although subscribe names message.reaction only"


def test_identity_hash_test_vector():
    def item(key: str, platform: str, id_: str) -> str:
        return hmac.new(key.encode("ascii"), f"{platform}:{id_}".encode("utf-8"), hashlib.sha256).hexdigest()[:20]

    assert item("pcp-1.1-test-key", "camfrog", "lilypadlou") == "f84004d41a6a8ddaf206"
    assert item("pcp-1.1-test-key", "camfrog", "LilyPadLou") == "59f5b268a7e190753538"
    spec = (REPO / "spec" / "PCP.md").read_text(encoding="utf-8")
    assert "f84004d41a6a8ddaf206" in spec and "59f5b268a7e190753538" in spec
