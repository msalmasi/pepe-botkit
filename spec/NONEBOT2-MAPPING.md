# PCP as a NoneBot2 adapter

Purpose: let work package **B-1** (NoneBot2 spike, decision D6) start coding immediately. It maps
every PCP concept onto NoneBot2's Driver / Adapter / Bot / Event / Message model, gives a skeleton
adapter, and lists what the spike has to prove before we adopt NoneBot2. If the spike fails, the
same split is what our own runtime implements (ARCHITECTURE §11.1).

Written against the NoneBot2 2.x API (`nonebot.adapters.Adapter`, `Bot`, `Event`, `Message`,
`MessageSegment`; ASGI driver with `setup_websocket_server`). Verify names against the version the
spike pins.

## 1. Layer mapping

| PCP / botkit | NoneBot2 | notes |
|---|---|---|
| runtime (WebSocket server, `/pcp/v1`) | **Driver** (`~fastapi`, ASGI) + **Adapter** registering a WebSocket route via `setup_websocket_server(WebSocketServerSetup(URL("/pcp/v1"), name, handler))` | connectors dial in (PCP §1), so the reverse/server side of NoneBot is what we use |
| one connector connection (`connector.id`, e.g. `cf-main`) | one **Bot**, `self_id = connector.id` | `bot_connect` on `welcome`, `bot_disconnect` on close; a resumed session reuses the same Bot object |
| hello / welcome / ack / ping / flow / bye / resume / seq | **inside the Adapter**, invisible to plugins | session table keyed by `session_id`, replay dedup by `seq` |
| event frame | **Event** subclass per PCP type, built with `type_validate_python` | see §3 |
| `message.content` elements | **MessageSegment** (one segment type per element) | see §4 |
| action + result | **`Bot.call_api(api, **data)`** → `Adapter._call_api` → action frame, awaits the final result | see §5 |
| error object | `ActionFailed` subclass (`PcpActionFailed`), `ApiNotAvailable`, `NetworkError` | see §5 |
| capabilities | `bot.capabilities` + per-room overrides; `bot.can(type, scope)`; a `Rule` factory | see §6 |
| matcher (priorities, permissions, duplicate-command check) | NoneBot matchers (`on_command`, `on_type`, `priority`, `block`, `permission`) | duplicate command names: our startup check over `nonebot.matcher.matchers` |
| module (manifest, settings schema, required capabilities) | **plugin** with `PluginMetadata(config=..., extra={"pcp": {...}})` | see §7 |
| bot instance (name, soul, enabled modules, room bindings) | no NoneBot equivalent → `run_preprocessor` that ignores matchers of plugins not enabled for the bot instance bound to `event.scope.room` | see §7 |

## 2. Adapter responsibilities

1. **Accept** the WebSocket on `/pcp/v1`, check subprotocol `pcp.v1` and the bearer token
   (`websocket.request.headers`), else close `4001`/`4002`.
2. **Handshake**: read `hello` within 10 s, validate with `pcp_schemas` (dev: always; prod: control
   frames only), negotiate the minor version, answer `welcome` (session id, heartbeat, limits,
   bindings from the admin console). On `resume`, find the session, answer `last_seq`.
3. **Receive loop**: per frame,
   - `event`: drop if `seq <= session.last_seq` (replay duplicate); parse into an Event model;
     `asyncio.create_task(nonebot.message.handle_event(bot, event))`; mark seq handled; ack every
     `ack_every_events` or on heartbeat.
   - `result`: resolve the pending future for `ref` (interim results → progress callback; duplicate
     finals ignored); same seq bookkeeping.
   - `flow`: update a per-scope send gate used by `_call_api`.
   - `ping`/`pong`/`bye`: heartbeat and shutdown handling.
4. **Send side**: `_call_api` builds the action frame, respects `flow` pauses and
   `max_inflight_actions`, stores it as pending (for re-send after resume), awaits the final result.
5. **Resume**: keep the session (pending actions, last seq) for `replay_window_ms` after a drop;
   re-send pending actions with their original ids on resume; on refusal fail them with
   `session_invalid` (PCP §13).

## 3. Events

NoneBot's `Event.get_type()` must return one of `message`, `notice`, `request`, `meta_event`.

| PCP type | NoneBot class | `get_type()` | `get_event_name()` |
|---|---|---|---|
| `message` | `RoomMessageEvent(MessageEvent)` | `message` | `message` |
| `message.private` | `PrivateMessageEvent(MessageEvent)` | `message` | `message.private` |
| `notice` | `NoticeTextEvent(NoticeEvent)` | `notice` | `notice` |
| `member.join` / `.leave` / `.update` | `MemberJoinEvent` / `MemberLeaveEvent` / `MemberUpdateEvent` | `notice` | the PCP type |
| `presence` | `PresenceEvent` | `notice` | `presence` |
| `mic.grab` / `mic.release` | `MicGrabEvent` / `MicReleaseEvent` | `notice` | the PCP type |
| `cam.open` / `cam.close` / `cam.view` | `CamOpenEvent` / `CamCloseEvent` / `CamViewEvent` | `notice` | the PCP type |
| `sticker` | `StickerEvent` | `notice` | `sticker` |
| `reaction` | `ReactionEvent` | `notice` | `reaction` |
| `moderation` | `ModerationEvent` | `notice` | `moderation` |
| `room.update` | `RoomUpdateEvent` | `notice` | `room.update` |
| `audio.segment` | `AudioSegmentEvent` | `notice` | `audio.segment` |
| `inbox.notify` | `InboxNotifyEvent` | `notice` | `inbox.notify` |
| `room.joined` / `room.left` | `RoomJoinedEvent` / `RoomLeftEvent` | `meta_event` | the PCP type |
| `connector.status` / `sync.gap` | `ConnectorStatusEvent` / `SyncGapEvent` | `meta_event` | the PCP type |
| unknown / `x.*` | `UnknownEvent(NoticeEvent)` with raw `data` | `notice` | the PCP type |

Other `Event` methods:

| method | value |
|---|---|
| `get_user_id()` | `f"{scope.platform}:{data.user.id}"` (e.g. `camfrog:lilypadlou`). Platform-prefixed so `SUPERUSERS` and per-user state never collide across platforms. Raise `ValueError` for events without a user. |
| `get_session_id()` | `f"{platform}:{room.id or '-'}:{thread.id or '-'}:{user.id}"` so `got`/`receive` conversations stay in the room (a Camfrog PM is room-scoped, which this preserves). |
| `get_message()` | `Message` from `data.content` if present, else `Message(data.text)` |
| `is_tome()` | `True` for `message.private`, else `data.mentions_self` |
| `get_event_description()` | short log line, with PM text redacted |

The base `Event` model carries the envelope: `id`, `ts`, `seq`, `type`, `connector`, `scope`,
`traceparent`, and the typed `data`. Generate the `data` pydantic models from
`schemas/events/*.schema.json` (e.g. `datamodel-code-generator`) and ship them in `pcp_schemas`
so connectors written in Python share them.

Self events (`data.self` / `user.is_self`): the adapter still delivers them, but a global
`event_preprocessor` drops them for matchers unless a plugin opts in (loggers do).

## 4. Message and segments

```python
class MessageSegment(BaseMessageSegment["Message"]):
    # type = PCP element type: text, mention, mention_all, emoji, link, media, sticker, quote, style
    @classmethod
    def get_message_class(cls): return Message
    def __str__(self): return self.data.get("text", "") if self.type == "text" else render_fallback(self)
    def is_text(self): return self.type == "text"

    @staticmethod
    def text(t: str): return MessageSegment("text", {"text": t})
    @staticmethod
    def mention(user: dict): return MessageSegment("mention", {"user": user})
    @staticmethod
    def media(media: dict): return MessageSegment("media", {"media": media})
    @staticmethod
    def sticker(sticker: dict): return MessageSegment("sticker", {"sticker": sticker})

class Message(BaseMessage[MessageSegment]):
    @classmethod
    def get_segment_class(cls): return MessageSegment
    @staticmethod
    def _construct(msg: str): yield MessageSegment.text(msg)
```

Outbound, the adapter turns a `Message` into `content` (segments → elements 1:1) plus a flattened
`text`, and lets the connector downgrade elements it can't render (PCP §9). Commands parse from the
plain text, so `COMMAND_START = ["!"]` gives today's `!bal` syntax on every platform.

## 5. Actions → `call_api`

`api` is the PCP action type. NoneBot's attribute sugar (`await bot.mic_grab(...)`) can't contain
dots, so the adapter maps `_` → `.` (`send_private` → `send.private`, `cam_self_set` →
`cam.self.set`). **Rule for PCP: standard type names never contain underscores**, so the mapping is
unambiguous; vendor `x.` types are called with `call_api("x.camfrog.foo", ...)` directly.

```python
await bot.call_api("kick", scope=event.scope, user=event.data.user, reason="link spam")
await bot.mic_grab(scope=event.scope, hold=True)                       # same as call_api("mic.grab", ...)
frame = await bot.cam_capture(scope=event.scope, user=target, open_if_closed=True, _timeout=20)
```

`_call_api(bot, api, **data)`:

1. Pop reserved kwargs: `scope`, `_timeout` (await deadline; long actions such as `audio.play` need
   minutes), `_timeout_ms` (PCP `timeout_ms`), `_on_progress` (interim results), `_origin`.
2. If `not bot.can(api, scope)` → raise `ApiNotAvailable` locally (no round trip).
3. Validate `data` against `actions/<api>.schema.json` in development.
4. Send the action frame (with `origin = {bot instance, plugin name, current event id}` and the
   current event's `traceparent`), await the future.
5. Final result `ok: true` → return `data` (a dict or the generated pydantic model).
   `ok: false` → raise `PcpActionFailed(code, message, retryable, retry_after_ms, platform_code)`
   (subclass of `nonebot.exception.ActionFailed`). Connection lost and resume refused → raise
   `NetworkError`.

`Bot.send(event, message, **kwargs)`: `message.private` events → `send.private` with the event's
scope and user; everything else → `send` to `event.scope` (thread preserved). `reply=True` sets
`reply_to` when the platform has message ids; `at_sender=True` sets `mention`.

## 6. Capabilities in plugins

```python
from nonebot import on_command
from pepe_botkit.pcp.rules import capability          # Rule factory

mic = on_command("mic", rule=capability("mic.grab", "mic.release"), priority=10, block=True)

@mic.handle()
async def _(bot: PcpBot, event: RoomMessageEvent):
    if not bot.can("audio.play", event.scope):        # optional feature inside a handler
        ...
```

`bot.can(type, scope)` uses the room's capability set from `room.joined` when present, else the
connector's `hello` set (PCP §8). `capability()` returns False for events from scopes that lack the
capabilities, so the matcher simply doesn't run there. Never branch on `scope.platform`.

## 7. Modules, bot instances, settings

- **Module = NoneBot plugin.** Manifest in `PluginMetadata.extra["pcp"]`: commands (help text),
  required capabilities, settings JSON Schema, owned data, required services. The admin console
  (B-5) reads these to render settings forms.
- **Bot instance** ("Pepe", "Pepe Casino") = admin-console record: enabled plugins + room bindings
  (`welcome.bindings`). A global `run_preprocessor(matcher, bot, event)` looks up the instance bound
  to `event.scope.room` and raises `IgnoredException` if `matcher.plugin_name` is not enabled for it.
- **Duplicate command names** across enabled plugins = startup error (fixes v1's first-match-wins
  collisions): scan matchers at `driver.on_startup`.
- **Per-room settings**: resolved by (bot instance, room) like v1 `_setting(key, room)`; plugins get
  them through a dependency (`Depends(room_settings)`).

## 8. Skeleton

```python
# pepe_botkit/adapters/pcp/adapter.py  (sketch - not tested)
import asyncio, json
from typing import Any
from nonebot import get_plugin_config
from nonebot.adapters import Adapter as BaseAdapter
from nonebot.compat import type_validate_python
from nonebot.drivers import ASGIMixin, URL, WebSocket, WebSocketServerSetup
from nonebot.exception import WebSocketClosed
from pcp_schemas import PcpValidator

from .bot import PcpBot
from .config import Config
from .event import EVENT_CLASSES, UnknownEvent
from .session import Session, SessionStore

class Adapter(BaseAdapter):
    def __init__(self, driver, **kwargs):
        super().__init__(driver, **kwargs)
        self.cfg = get_plugin_config(Config)
        self.validator = PcpValidator()
        self.sessions = SessionStore(ttl_ms=self.cfg.pcp_replay_window_ms)
        if not isinstance(self.driver, ASGIMixin):
            raise RuntimeError("PCP adapter needs an ASGI driver (DRIVER=~fastapi)")
        self.setup_websocket_server(WebSocketServerSetup(URL("/pcp/v1"), self.get_name(), self._handle_ws))

    @classmethod
    def get_name(cls) -> str:
        return "PCP"

    async def _handle_ws(self, ws: WebSocket) -> None:
        if not self._authorized(ws.request.headers):          # bearer token per connector id
            await ws.close(4001, "unauthorized"); return
        await ws.accept()                                      # spike: subprotocol echo (see 9.2)
        hello = json.loads(await asyncio.wait_for(ws.receive_text(), 10))
        if not self.validator.validate_frame(hello).valid or hello["op"] != "hello":
            await ws.close(4000, "expected hello"); return
        session, welcome = self.sessions.open_or_resume(hello, self.cfg)
        await ws.send_text(json.dumps(welcome))
        bot = session.bot or PcpBot(self, hello["data"]["connector"]["id"], session)
        session.attach(ws, bot)
        self.bot_connect(bot)
        try:
            await session.resend_pending_actions()
            while True:
                frame = json.loads(await ws.receive_text())
                await self._on_frame(session, bot, frame)
        except WebSocketClosed:
            pass
        finally:
            session.detach()                                   # keep for resume until TTL
            self.bot_disconnect(bot)

    async def _on_frame(self, session: Session, bot: PcpBot, frame: dict) -> None:
        op = frame.get("op")
        if op in ("event", "result"):
            if not session.accept_seq(frame["seq"]):           # replay duplicate
                return
            if op == "event":
                cls = EVENT_CLASSES.get(frame["type"], UnknownEvent)
                event = type_validate_python(cls, frame)
                asyncio.create_task(bot.handle_event(event))
            else:
                session.resolve(frame)                         # interim -> progress, final -> future
            await session.maybe_ack()
        elif op == "flow":
            session.flow.update(frame["data"])
        elif op == "ping":
            await session.send({"op": "pong", "ref": frame["id"]})
        elif op == "bye":
            await session.close_from_peer(frame["data"])

    async def _call_api(self, bot: PcpBot, api: str, **data: Any) -> Any:
        return await bot.session.call(api.replace("_", "."), **data)   # raises PcpActionFailed etc.
```

## 9. Spike checklist (B-1)

The spike passes if all of these work with the samples in this repo replayed by a fake connector:

1. **Lifecycle**: hello/welcome, `bot_connect`/`bot_disconnect`, heartbeat close `4008`, replaced
   connection `4009`.
2. **Subprotocol**: can the NoneBot WebSocket abstraction echo `Sec-WebSocket-Protocol: pcp.v1`?
   (FastAPI/Starlette can; check `nonebot.drivers` exposes it.) If not, rely on the `/pcp/v1` path
   and read the header ourselves.
3. **Resume**: Bot object survives a reconnect without plugins seeing a disconnect/connect storm;
   seq dedup; pending actions re-sent with the same ids; `session_invalid` on refusal.
4. **Concurrency**: `handle_event` per event in tasks; one slow plugin (LLM call) must not block the
   receive loop (v1's worst bug class: slow handlers froze the bot).
5. **Long actions**: `audio.play` with interim results and a multi-minute timeout through
   `call_api`.
6. **Capabilities**: `capability()` rule and `ApiNotAvailable` before sending.
7. **Bot instances**: `run_preprocessor` gating plugins per (instance, room); two instances on one
   connector.
8. **Commands**: `!` prefix, duplicate-name startup error, help text from metadata.
9. **Identity**: `get_user_id` prefixing works with `SUPERUSERS`; display vs login never mixed up.
10. **Throughput**: replay 10k events (Camfrog mic heartbeats are already collapsed by the connector,
    so realistic load is low) and measure latency event → action.

Decision rule: if 3, 4 or 7 needs patching NoneBot internals, build our own runtime with the same
layers and keep this mapping as its design.
