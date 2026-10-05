"""Validate every PCP sample and reject every deliberately bad sample (mirror of the TS tests)."""
from __future__ import annotations

import json
import subprocess
import shutil
from pathlib import Path

import pytest

from pcp_schemas import PcpValidator, default_schema_dir

REPO = default_schema_dir().parent
SAMPLES = REPO / "samples"
VALID_FILES = sorted(p for d in ("camfrog", "discord", "twitch") for p in (SAMPLES / d).glob("*.json"))
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


def test_validate_data():
    assert validator.validate_data("event", "mic.grab", {"user": {"id": "someone"}}).valid
    assert not validator.validate_data("event", "mic.grab", {}).valid
    assert validator.validate_data("result", "sticker.send", {"posted": None}).valid
    assert not validator.validate_data("action", "nope", {}).known


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
