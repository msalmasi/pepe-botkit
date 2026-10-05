# pepe-botkit

Toolkit for Pepe-style chat bots that run on several platforms at once. This repository currently
holds **PCP, the Pepe Connector Protocol**: the WebSocket protocol between platform **connectors**
(Camfrog, Discord, Twitch, Telegram, an audio pipeline) and the **bot runtime** (matcher + modules),
with JSON Schemas, sample traffic and validators for TypeScript and Python. The runtime itself, the
matcher and the module SDK come next (they may be built on NoneBot2, see
[`spec/NONEBOT2-MAPPING.md`](spec/NONEBOT2-MAPPING.md)).

```
platform <--native--> connector ==PCP (JSON over WebSocket, pcp.v1)==> runtime -> matcher -> modules
```

- Connectors send **events** (`message`, `mic.grab`, `moderation`, `audio.segment`, …) and execute
  **actions** (`send`, `kick`, `mic.grab`, `cam.capture`, `user.list`, …), each answered by a
  **result** or a structured **error**.
- Connectors declare **capabilities**; modules check capabilities, never platform names.
- Sessions are resumable: events carry sequence numbers, the runtime acks them, actions are
  idempotent by id.

## Layout

| path | what |
|---|---|
| [`spec/PCP.md`](spec/PCP.md) | the protocol (normative) |
| [`spec/NONEBOT2-MAPPING.md`](spec/NONEBOT2-MAPPING.md) | how PCP maps onto a NoneBot2 adapter |
| [`schemas/`](schemas) | JSON Schema draft 2020-12: `envelope`, `frame`, `event`/`action`/`result` dispatch, `control/*`, `events/*`, `actions/*`, `results/*`, `error`, `capabilities`, shared `defs`; [`index.json`](schemas/index.json) registers every type |
| [`samples/`](samples) | sample sessions: `camfrog/` (grounded in the current Camfrog bot), `discord/`, `twitch/`; `invalid/` holds frames that must be rejected |
| [`packages/pcp-schemas`](packages/pcp-schemas) | TypeScript validator (Ajv) |
| [`python/`](python) | Python validator (`pcp_schemas`, jsonschema) |
| [`scripts/gen-dispatch.mjs`](scripts/gen-dispatch.mjs) | regenerates the dispatch schemas from `index.json` (`--check` for CI) |

## Using the validators

TypeScript:

```ts
import { PcpValidator } from "@pepe-botkit/pcp-schemas";
const pcp = new PcpValidator();                 // loads ../../schemas, or $PCP_SCHEMA_DIR
const r = pcp.validateFrame(frame);             // { valid, known, errors: [{ path, message }] }
pcp.validateData("action", "mic.grab", { hold: true });
```

Python:

```python
from pcp_schemas import PcpValidator
pcp = PcpValidator()                            # loads ../schemas, or $PCP_SCHEMA_DIR
r = pcp.validate_frame(frame)                   # ValidationResult(valid, known, errors)
```

`known` is false for event/action types newer than the loaded schemas: such frames are still valid
if the envelope is (receivers ignore unknown types, see PCP §14).

## Development

Requirements: Node 20+, Python 3.10+.

```sh
npm install
npm test                                        # dispatch check + TS tests

cd python
python -m venv .venv && .venv/Scripts/python -m pip install -e ".[test]"   # bin/ on Linux/macOS
.venv/Scripts/python -m pytest
```

Adding or changing a type:

1. Edit or add `schemas/events|actions|results/<type>.schema.json` and register it in
   `schemas/index.json` (`requires_room`, `priority`, `result`).
2. `npm run gen` to rebuild `event/action/result/frame.schema.json`.
3. Add at least one sample frame (the tests require every type to have one) and, for new
   constraints, a bad sample in `samples/invalid/` with the JSON pointer where it must fail.
4. Follow the additive-only rules in PCP §14.

## Sample data

All users, rooms, ids, tokens and URLs in `samples/` are invented. The Camfrog samples reproduce the
*shape* of what today's Camfrog bot receives and does (packet types and behaviours are cited in each
file's `grounding` note), never real traffic.

## Status

Draft 1.0 of the protocol (work package F-4). Open questions are listed at the end of
[`spec/PCP.md`](spec/PCP.md#18-open-questions). Licence: [MIT](LICENSE).
