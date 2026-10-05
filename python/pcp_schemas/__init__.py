"""PCP (Pepe Connector Protocol) schema loader and frame validator.

Loads every ``*.schema.json`` under the schema directory into a ``referencing`` registry and
validates whole frames against ``frame.schema.json`` (draft 2020-12), which dispatches on ``op``
and then on ``type``.

    from pcp_schemas import PcpValidator
    v = PcpValidator()
    result = v.validate_frame(frame)
    if not result.valid:
        for err in result.errors:
            print(err.path, err.message)
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

__all__ = ["PcpValidator", "ValidationResult", "PcpValidationError", "default_schema_dir", "SUBPROTOCOL"]

SUBPROTOCOL = "pcp.v1"


def default_schema_dir() -> Path:
    """repo/schemas, resolved from this file, unless PCP_SCHEMA_DIR is set."""
    env = os.environ.get("PCP_SCHEMA_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent.parent / "schemas"


@dataclass
class PcpValidationError:
    path: str          # JSON pointer into the frame, e.g. "/data/user/id"
    message: str
    keyword: str
    schema_path: str


@dataclass
class ValidationResult:
    valid: bool
    known: bool        # False if the event/action type is not in this schema version
    errors: list[PcpValidationError] = field(default_factory=list)


def _pointer(parts: Iterable[Any]) -> str:
    parts = [str(p).replace("~", "~0").replace("/", "~1") for p in parts]
    return "/" + "/".join(parts) if parts else "/"


def _leaves(errors: Iterable[ValidationError]) -> list[ValidationError]:
    out: list[ValidationError] = []
    for e in errors:
        out.append(e)
        if e.context:
            out.extend(_leaves(e.context))
    return out


def _convert(errors: Iterable[ValidationError]) -> list[PcpValidationError]:
    return [
        PcpValidationError(
            path=_pointer(e.absolute_path),
            message=e.message,
            keyword=str(e.validator),
            schema_path=_pointer(e.absolute_schema_path),
        )
        for e in _leaves(errors)
    ]


class PcpValidator:
    def __init__(self, schema_dir: str | os.PathLike | None = None):
        self.schema_dir = Path(schema_dir) if schema_dir else default_schema_dir()
        self.index: dict = json.loads((self.schema_dir / "index.json").read_text(encoding="utf-8"))
        self.base: str = self.index["base"]
        resources = []
        for path in sorted(self.schema_dir.rglob("*.schema.json")):
            contents = json.loads(path.read_text(encoding="utf-8"))
            resources.append((contents["$id"], Resource(contents=contents, specification=DRAFT202012)))
        self.registry: Registry = Registry().with_resources(resources)
        self._validators: dict[str, Draft202012Validator] = {}
        self._frame = self._validator(self.index["frame"])

    def _validator(self, rel: str) -> Draft202012Validator:
        if rel not in self._validators:
            schema = self.registry.contents(self.base + rel)
            self._validators[rel] = Draft202012Validator(
                schema,
                registry=self.registry,
                format_checker=Draft202012Validator.FORMAT_CHECKER,
            )
        return self._validators[rel]

    def is_known(self, frame: Any) -> bool:
        if not isinstance(frame, dict):
            return False
        op = frame.get("op")
        if op == "event":
            return frame.get("type") in self.index["events"]
        if op in ("action", "result"):
            return frame.get("type") in self.index["actions"]
        return op in self.index["control"]

    def validate_frame(self, frame: Any) -> ValidationResult:
        errors = list(self._frame.iter_errors(frame))
        return ValidationResult(valid=not errors, known=self.is_known(frame), errors=_convert(errors))

    def validate_data(self, kind: str, type_: str, data: Any) -> ValidationResult:
        """Validate only the data payload of an event, action or (successful, final) result."""
        rel = None
        if kind == "event":
            rel = self.index["events"].get(type_, {}).get("schema")
        elif kind == "action":
            rel = self.index["actions"].get(type_, {}).get("schema")
        elif kind == "result":
            r = self.index["actions"].get(type_, {}).get("result")
            rel = self.index["results"].get(r) if r else None
        if not rel:
            return ValidationResult(False, False, [PcpValidationError("/", f"unknown {kind} type {type_}", "type", "")])
        errors = list(self._validator(rel).iter_errors(data))
        return ValidationResult(valid=not errors, known=True, errors=_convert(errors))

    def assert_frame(self, frame: Any) -> None:
        result = self.validate_frame(frame)
        if not result.valid:
            lines = "\n".join(f"  {e.path}: {e.message}" for e in result.errors)
            raise ValueError(f"invalid PCP frame:\n{lines}")
