"""Test helper: find fields a 1.1 schema set defines but a 1.0 set does not, in one frame.

Mirror of packages/pcp-schemas/test/compat.ts. Both schema sets allow unknown properties
(spec/PCP.md §14), so validating against the 1.0 schemas cannot prove that a frame carries no 1.1
field. This walks the frame along both sets at once, following $ref, allOf/anyOf/oneOf and
if/then/else (a branch is taken when its ``if`` can be decided from const/enum/required, both
otherwise), and reports every key the 1.1 schemas name at that place while the 1.0 schemas neither
name it nor allow it as a map value.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urldefrag, urljoin


def _if_matches(cond: Any, data: Any) -> bool | None:
    if not isinstance(cond, dict) or not isinstance(data, dict):
        return None
    unknown = False
    for k, v in cond.items():
        if k == "required":
            if any(r not in data for r in v):
                return False
        elif k == "properties":
            for p, sub in v.items():
                if p not in data:
                    continue
                if "const" in sub and sub["const"] != data[p]:
                    return False
                if isinstance(sub.get("enum"), list) and data[p] not in sub["enum"]:
                    return False
                if any(x not in ("const", "enum", "description", "$comment") for x in sub):
                    unknown = True
        elif k not in ("description", "$comment"):
            unknown = True
    return None if unknown else True


class SchemaSet:
    def __init__(self, schema_dir: Path):
        self.by_id: dict[str, Any] = {}
        for path in sorted(Path(schema_dir).rglob("*.schema.json")):
            s = json.loads(path.read_text(encoding="utf-8"))
            self.by_id[s["$id"]] = s
        index = json.loads((Path(schema_dir) / "index.json").read_text(encoding="utf-8"))
        root = index["base"] + index["frame"]
        self.root = (self.by_id[root], root)

    def _resolve(self, ref: str, base: str) -> tuple[Any, str]:
        url, frag = urldefrag(urljoin(base, ref))
        s = self.by_id[url]
        for part in unquote(frag).split("/")[1:]:
            s = s[part.replace("~1", "/").replace("~0", "~")]
        return s, url

    def expand(self, node: tuple[Any, str], data: Any, out: list | None = None, depth: int = 0) -> list:
        out = [] if out is None else out
        s, base = node
        if not isinstance(s, dict) or depth > 64:
            return out
        if isinstance(s.get("$id"), str):
            base = urljoin(base, s["$id"])
        out.append((s, base))
        if isinstance(s.get("$ref"), str):
            self.expand(self._resolve(s["$ref"], base), data, out, depth + 1)
        for k in ("allOf", "anyOf", "oneOf"):
            for sub in s.get(k, []):
                self.expand((sub, base), data, out, depth + 1)
        if "if" in s:
            m = _if_matches(s["if"], data)
            if m is not False and "then" in s:
                self.expand((s["then"], base), data, out, depth + 1)
            if m is not True and "else" in s:
                self.expand((s["else"], base), data, out, depth + 1)
        return out


def _props(nodes: list) -> tuple[dict[str, list], list, list]:
    named: dict[str, list] = {}
    values: list = []
    items: list = []
    for s, base in nodes:
        for k, sub in (s.get("properties") or {}).items():
            named.setdefault(k, []).append((sub, base))
        if isinstance(s.get("additionalProperties"), dict):
            values.append((s["additionalProperties"], base))
        if isinstance(s.get("items"), dict):
            items.append((s["items"], base))
    return named, values, items


def fields_only_in(newer: SchemaSet, older: SchemaSet, frame: Any) -> list[str]:
    """JSON pointers of the keys in ``frame`` that only ``newer`` defines."""
    found: list[str] = []

    def walk(data: Any, n_new: list, n_old: list, at: str) -> None:
        e_new = [x for n in n_new for x in newer.expand(n, data)]
        e_old = [x for n in n_old for x in older.expand(n, data)]
        named_new, values_new, items_new = _props(e_new)
        named_old, values_old, items_old = _props(e_old)
        if isinstance(data, list):
            for i, item in enumerate(data):
                walk(item, items_new, items_old, f"{at}/{i}")
        elif isinstance(data, dict):
            for k, v in data.items():
                in_new = named_new.get(k)
                in_old = named_old.get(k)
                if in_new and not in_old and not values_old:
                    found.append(f"{at}/{k}")
                    continue
                c_new = in_new or values_new
                c_old = in_old or values_old
                if c_new and c_old:
                    walk(v, c_new, c_old, f"{at}/{k}")

    walk(frame, [newer.root], [older.root], "")
    return found
