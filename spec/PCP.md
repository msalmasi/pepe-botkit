# PCP — Pepe Connector Protocol, version 1.0

Status: **draft 1.0** (work package F-4 of the v2 rebuild). Normative words (MUST, SHOULD, MAY) are
used in the RFC 2119 sense. The JSON Schemas in [`../schemas`](../schemas) are normative for frame
shape; this document is normative for behaviour. Where they disagree, file a bug.

PCP connects a **connector** (a process that speaks one chat platform: Camfrog, Discord, Twitch,
Telegram, the PATV rooms service, or an audio pipeline) to a **bot runtime** (matcher + modules).
Connectors send **events** and execute **actions**; the runtime decides what to do. Modules never
see platform protocols, only PCP, and they check **capabilities**, never platform names.

```
 platform  <--native-->  connector  ==PCP over WebSocket==>  runtime --> matcher --> modules
 (Camfrog client,         (cf-connector,                        (botkit / NoneBot2 adapter)
  Discord gateway, ...)    audiohook, discord-connector, ...)
```

Contents

1. [Transport](#1-transport)
2. [Session lifecycle and authentication](#2-session-lifecycle-and-authentication)
3. [Frames and the envelope](#3-frames-and-the-envelope)
4. [Identity, rooms and scope](#4-identity-rooms-and-scope)
5. [Events](#5-events)
6. [Actions](#6-actions)
7. [Results and the error model](#7-results-and-the-error-model)
8. [Capabilities](#8-capabilities)
9. [Message content](#9-message-content)
10. [Private messages and the inbox](#10-private-messages-and-the-inbox)
11. [Media](#11-media)
12. [Rate limits and backpressure](#12-rate-limits-and-backpressure)
13. [Heartbeats, reconnect and resume](#13-heartbeats-reconnect-and-resume)
14. [Versioning and extensions](#14-versioning-and-extensions)
15. [Security and privacy](#15-security-and-privacy)
16. [Worked examples](#16-worked-examples)
17. [Camfrog (cf-connector) mapping](#17-camfrog-cf-connector-mapping)
18. [Open questions](#18-open-questions)

---

## 1. Transport

- **WebSocket** (RFC 6455) over TLS (`wss://`). Plain `ws://` is allowed only on loopback or inside
  an authenticated private network (e.g. a tailnet).
- **The connector dials the runtime.** Connectors run next to their platform (a Windows VM for the
  Camfrog client, a container for Discord), often behind NAT; the runtime is the stable endpoint.
  Default path: `/pcp/v1`.
- **Subprotocol** `pcp.v1` (`Sec-WebSocket-Protocol`). The digit is the protocol MAJOR version. A
  runtime that does not support the offered major refuses the upgrade (HTTP 400) or, if it already
  upgraded, closes with code `4002`.
- **One frame per WebSocket text message**, UTF-8 JSON object. Binary WebSocket messages are not
  used in v1 (media goes through the blob store, §11). Frames larger than
  `welcome.data.limits.max_frame_bytes` (default 1 MiB) MUST NOT be sent.
- Within one connection, frames are processed in the order received.

## 2. Session lifecycle and authentication

```
connector                                   runtime
    |--- WebSocket upgrade (pcp.v1, Bearer) --->|
    |--- hello  {pcp, connector, capabilities} ->|   (within 10 s of upgrade)
    |<-- welcome {pcp, session_id, heartbeat_ms, bindings, resume?}
    |--- [replayed events/results, if resumed] ->|
    |=== events, results, flow, ping/pong ======>|
    |<== actions, ack, flow, ping/pong ==========|
    |--- bye {reconnect} ----------------------->|   (either side, then close)
```

**Authentication.** Each connector instance has its own token, issued by the admin console and
scoped to that connector id (it cannot impersonate another connector). The connector SHOULD send it
as `Authorization: Bearer <token>` on the upgrade request. Clients that cannot set headers put it in
`hello.data.auth.token` instead. The runtime MUST reject a missing/invalid token with `bye`
(`error.code = unauthorized`) and close code `4001`. Tokens never appear in logs or in any other
frame. A connector whose `hello.data.connector.id` does not match its token is rejected the same way.

**hello** (connector → runtime, first frame, [`control/hello.schema.json`](../schemas/control/hello.schema.json)):
connector id/platform/kind/software version, the bot's own account if known (`self`), the full
capability declaration (§8), and optionally `resume` (§13). If no hello arrives within 10 s the
runtime closes with `4004`.

**welcome** (runtime → connector, [`control/welcome.schema.json`](../schemas/control/welcome.schema.json)):

| field | meaning |
|---|---|
| `pcp` | negotiated version (see below) |
| `session_id` | id of this session (new, or the resumed one) |
| `heartbeat_ms` | ping interval for both sides (§13) |
| `resume` | result of a resume request: `accepted`, `last_seq` |
| `limits` | `max_frame_bytes`, `max_inflight_actions`, replay window, ack cadence |
| `bindings` | rooms this connector should be in (from bot-instance bindings in the admin console), with `rejoin_on_kick` and which room is the `audio` room. Passwords are never sent here; a password room is joined by a `room.join` action. |
| `subscribe` | optional: event types the runtime wants; the connector MAY skip others (bandwidth, e.g. `audio.segment`) |

**Version negotiation.** The subprotocol fixes MAJOR. `hello.data.pcp` is the connector's highest
`MAJOR.MINOR`; the runtime answers `MINOR = min(connector, runtime)`. Both sides then MUST NOT send
fields or types introduced after the negotiated minor (receivers ignore them anyway, §14).

**One live connection per connector id.** If a connector id connects while another connection with
the same id is live, the runtime closes the OLD one with `4009` (replaced) and continues with the new
one (resuming if asked).

**bye** (either side, [`control/bye.schema.json`](../schemas/control/bye.schema.json)) explains a
deliberate close: `reconnect` (should the peer come back), `retry_after_ms`, and an `error`.

## 3. Frames and the envelope

Every frame has ([`envelope.schema.json`](../schemas/envelope.schema.json)):

| field | type | notes |
|---|---|---|
| `op` | enum | `hello` `welcome` `event` `action` `result` `ack` `ping` `pong` `flow` `bye` |
| `id` | string | unique per sender per session. ULIDs recommended (sortable). |
| `ts` | RFC 3339 | when the sender created the frame (UTC, ms precision recommended) |
| `traceparent` | string | optional W3C Trace Context; the runtime copies an event's trace into the actions it causes so one OpenTelemetry trace spans platform → module → platform |

Op-specific fields:

| op | direction | extra fields |
|---|---|---|
| `event` | c → r | `seq`, `type`, `connector`, `scope`, `data` |
| `action` | r → c | `type`, `scope?`, `data`, `timeout_ms?`, `origin?` |
| `result` | c → r | `seq`, `ref` (action id), `type` (action type, echoed), `ok`, `final?`, `data` or `error` |
| `ack` | r → c | `seq` (cumulative) |
| `ping` / `pong` | both | `pong.ref` = ping id; connector pongs carry `platform_ok`, `last_seq` |
| `flow` | both | `data.state` = `slow` / `pause` / `resume` (§12) |
| `hello` / `welcome` / `bye` | §2 | |

`seq` is assigned by the connector to **every event and result** in a session: starts at 1,
increases by exactly 1, never reused within the session. It drives acks, replay and dedup (§13).

`origin` on an action records who caused it (`bot` instance id, `module`, triggering `event` frame
id, the `user` on whose behalf) for audit logs and for platforms that attribute actions.

Unknown top-level fields MUST be ignored. An unknown `op` MUST be ignored (and logged).

## 4. Identity, rooms and scope

### 4.1 Users

A user is a [`UserRef`](../schemas/defs.schema.json): the global key is **(platform, id)**. The
identity service maps that pair to a PATV account (link/claim flow, work package F-3).

| field | meaning | Camfrog | Discord | Twitch |
|---|---|---|---|---|
| `id` | stable key, never shown | login, **lowercased** | user snowflake | numeric user id |
| `login` | account name as spelled; what platform commands take | login (e.g. `LilyPadLou`) | username | login |
| `display` | what people see; markup stripped; may change any time | display name from 0x41 / PM markup | global name / nickname | display name |
| `display_raw` | as delivered, with markup | `<b><n>lou</n></b>` | — | — |
| `is_self` | the connector's own account | ✓ | ✓ | ✓ |
| `is_bot` | known automated account | room bots (config) | bot flag | known bots |
| `roles` | room/guild roles where known | admin/moderator/friend | role names | badges |

Rules:

- **Never key anything on `display`.** On Camfrog the display name and the login can be
  completely different (the PM packet carries the display only inside a markup string, and the real
  login in a separate field); v1 bugs where the bot called people by the wrong name came from mixing
  these up.
- A connector MUST fill `id` with the most stable identifier it has. If it only has a display name
  (e.g. an inbox read by vision, §10), it MUST NOT invent an `id` from it; it sends the name in a
  non-identity field instead (`inbox.read` → `conversations[].name`).
- `is_self: true` marks the bot. Connectors MUST report the bot's own messages/stickers/mic grabs
  with `self`/`is_self` rather than suppress them silently; matchers ignore self events by default.

### 4.2 Rooms, channels, threads, DMs

A [`RoomRef`](../schemas/defs.schema.json) has a stable `id`, an optional display `name` and a
`kind`: `room` (Camfrog room), `channel`, `thread`, `dm`, `group` (a whole guild/server as a
membership container), `voice`, `stage`, `inbox`.

- Camfrog: `id` is the room id from the JOIN packet (e.g. `LilyPond.Room`), `name` the display name
  ("The Lily Pond"). The client window title (`"<name>, Topic: …"`) is neither and never appears
  in PCP.
- Discord: `guild` + `room` (channel) + optional `thread` (`parent_id` = channel).
- Twitch: the room is the broadcaster's channel (`id` = broadcaster user id).

### 4.3 Scope

Every event carries `scope` ([`Scope`](../schemas/defs.schema.json)): `platform` (always),
`guild?`, `room?`, `thread?`. Events about a room (messages, members, mic, cams, moderation,
room lifecycle, audio) MUST have `scope.room`; the schemas enforce this per type
(`requires_room` in [`index.json`](../schemas/index.json)). Connector-wide events (presence, inbox,
connector.status, sync.gap) may omit it.

Actions carry `scope` to say **where** to act. Room-bound actions (send, kick, mic.grab, …) MUST
have `scope.room`. The runtime routes an action to the connector bound to that scope that declares
the action type.

## 5. Events

Delivery is **at-least-once**, in `seq` order per session. The runtime de-duplicates by `seq`
(anything ≤ the last processed seq of the session is a replay). Connectors MUST NOT emit the same
platform occurrence twice under different seqs (v1's IOCP bug, where one packet was reported
several times and commands ran twice, is exactly what this forbids; fix it at capture, not with
content filters that also eat genuine repeats).

Each event type has a **priority** used under backpressure (§12): `critical` events are never
dropped, `normal` events are never dropped within the replay window, `low` events may be dropped
(and the drop reported with `sync.gap`).

| type | prio | room | data (required **bold**) | notes |
|---|---|---|---|---|
| `message` | normal | ✓ | **user**, **text**, message_id, content, reply_to, self, mentions_self, edited | Camfrog: 0x06 with a sender. `text` is always the plain rendering. |
| `message.private` | normal | – | same as message | Camfrog: 0x60, `scope.room` = room it came through. Discord: DM channel. Twitch: whisper (no room). |
| `notice` | normal | – | **text**, kind, user, content | Server/system text: Camfrog empty-sender 0x06, Discord system messages, Twitch USERNOTICE. Parsed meaning is ALSO emitted as `moderation` / `room.update`. |
| `member.join` | normal | ✓ | **user**, initial, group, on_cam | `initial: true` = part of the snapshot when the bot joins (greeters skip it). |
| `member.leave` | normal | ✓ | **user**, reason, inferred | `inferred: true` when derived from a list diff (Camfrog has no known leave packet). |
| `member.update` | normal | ✓ | **user**, **changes** | display, roles, group, on_cam, idle. |
| `presence` | low | – | **user**, **status**, activity | Account-level online state (contact list, Discord presence). |
| `mic.grab` | normal | ✓ | **user**, session, holders, slots | Onset of a hold. Rooms can be multi-mic: `holders` is the full set after the event. |
| `mic.release` | normal | ✓ | **user**, reason, held_ms, session, holders | `reason`: released / blocked / timeout / lost / kicked / left / unknown. |
| `cam.open` | normal | ✓ | **user**, stream | A camera is broadcasting; `stream.id` is opaque connector state. |
| `cam.close` | normal | ✓ | **user**, reason | |
| `cam.view` | low | – | **viewer**, **target**, **state**, viewer_count | Someone watching a cam (Camfrog: only the bot's own cam is observable). |
| `sticker` | normal | ✓ | **user**, **sticker**, message_id, self | `sticker.media` points at the image. |
| `reaction` | low | ✓ | **user**, **message_id**, **emoji**, **op** | Needs `features.reactions`. |
| `room.joined` | critical | ✓ | **room**, topic, member_count, self, motd, rejoin, capabilities | The room is usable (Camfrog: after the server's logged-in line). May narrow capabilities (§8). |
| `room.left` | critical | ✓ | **room**, **reason**, by, detail, will_rejoin | requested / kicked / banned / disconnected / closed / unknown. |
| `room.update` | normal | ✓ | **room**, **changes**, by | topic, name. |
| `moderation` | critical | ✓ | **kind**, actor, target, duration_s, role, reason, source, text | Observed moderation by anyone (including the bot). `source`: server / room_bot / platform / connector. |
| `audio.segment` | low | ✓ | **media**, **started_at**, **ended_at**, **attribution**, speaker, overlap, part, final, levels | From audiohook. Audio as a media ref; STT runs downstream. |
| `inbox.notify` | normal | – | unread, at, user | Content-free DM activity ping (Camfrog 0x57). |
| `connector.status` | critical | – | **state**, detail, components | ready / degraded / platform_down / recovering. |
| `sync.gap` | critical | – | **reason**, from_seq, to_seq, dropped_types, scopes | Events were lost; modules with derived state (mic holders, member lists) re-snapshot via `user.list`. |

`moderation.kind`: `kick`, `ban`, `unban`, `mute` (Camfrog punish / Discord & Twitch timeout, with
`duration_s`), `unmute`, `mic.block`, `mic.unblock`, `role.add`, `role.remove` (with `role`), `warn`,
`delete`, `other`. Lines reported by a room's own chat bot (`source: room_bot`) are weaker evidence
than server lines; automod modules SHOULD weigh them accordingly.

Events added beyond the §11.2 list, and why:

| added | why (v1 evidence) |
|---|---|
| `notice` | v1 parses moderation, topic and "logged in" from server lines and taps them for `/watchlist` answers; modules need the raw line too. |
| `cam.view` | v1 reacts when someone opens the bot's own cam (s2c 0x15). |
| `room.update` | topic changes (v1 `_track_room_topic`; the topic also identifies Camfrog windows). |
| `reaction` | ARCHITECTURE §11.2 names reactions as a Discord capability. |
| `inbox.notify` | Camfrog DM activity (0x57) is separate from room PMs. |
| `connector.status` | the Camfrog client/hook can die while the WebSocket is fine; modules must know (v1 had supervisors for this). |
| `sync.gap` | explicit loss signal for resume failures and dropped low-priority events. |

## 6. Actions

Actions flow runtime → connector. Rules:

1. Every action gets **exactly one final result** (`ref` = action id), possibly preceded by interim
   results with `final: false` (long-running actions, e.g. `audio.play`: queued → playing → played).
2. Actions are **idempotent by id**: a connector that receives an action id it has already executed
   (or is executing) MUST NOT execute it again; it re-sends the cached final result (or nothing yet
   if still running). Connectors keep results for at least the replay window.
3. `timeout_ms`: if the connector cannot **start** the action within this time it returns
   `timeout` (retryable). Once started, an action runs to completion.
4. An unknown or undeclared action type is answered with `unsupported` (not retryable).
5. Actions are executed in arrival order **per room**; different rooms MAY run concurrently.
   The runtime keeps at most `max_inflight_actions` without a final result.

| type | room | data (required **bold**) | result data | maps to (Camfrog) |
|---|---|---|---|---|
| `send` | ✓ | **text** or **content**, reply_to, mention | message_ids, **parts**, truncated | 0x06 inject, split at `limits.message_max_chars` |
| `send.private` | –* | **user**, **text** or **content** | same as send | `/msg <login> <text>` through `scope.room` |
| `kick` | ✓ | **user**, reason | – | `/kick` |
| `ban` | ✓ | **user**, reason, duration_s, delete_history_s | – | `/ban` |
| `unban` | ✓ | **user** | – | `/unban` |
| `mute` | ✓ | **user**, duration_s, reason | – | `/punish` (server-fixed duration) |
| `unmute` | ✓ | **user** | – | `/unpunish` |
| `mic.block` | ✓ | **user** | – | `/blockmic` |
| `mic.unblock` | ✓ | **user** | – | `/unblockmic` |
| `role.set` | ✓ | **user**, **role**, **op** (add/remove) | – | `/oplist add\|remove <u> <role>`, `/addfriend` |
| `topic.set` | ✓ | **topic** | – | `/topic` |
| `room.join` | – | **room** (id and/or name), password, accept_motd, wait_ms | **room**, **joined**, topic | Join Room dialog |
| `room.leave` | ✓ | reason | – | close the room window |
| `room.list` | – | – | **rooms** (active, audio, member_count) | socket/fd map |
| `mic.grab` | ✓ | hold, force, wait_ms | **held**, waited_ms, bumped | Talk button (arms audio + 0x07) |
| `mic.release` | ✓ | – | **held**=false | Talk button (disarm + 0x08) |
| `audio.play` | ✓ | **media**, mode, mic, wait_for_slot_ms, caption, label | **status**, waited_ms, played_ms, dropped_reason | WAV → virtual cable, mic auto-grab |
| `cam.capture` | ✓ | **user**, open_if_closed, wait_ready_ms, max_width, format | **media**, **captured_at**, opened, ready_score | PrintWindow on `VideoViewport` |
| `cam.open` | ✓ | **user** | **opened**, method | user-list menu "View Webcam" / 0x0d inject |
| `cam.close` | ✓ | **user** | – | close the cam window |
| `cam.self.set` | – | hq, paused (≥1) | hq, paused | own-video panel buttons |
| `user.list` | ✓ | refresh | **members**, **complete**, count, method | owner-drawn list capture |
| `sticker.send` | ✓ | **sticker** | **posted** (true/false/null) | 0x3f inject (+ 0x58 ack on some servers) |
| `sticker.list` | – | query, limit | **stickers** | local sticker cache |
| `inbox.read` | – | limit | **conversations**, **method**, confidence, image | Conversations window + vision |
| `react` | ✓ | **message_id**, **emoji**, **op** | – | (Discord/Telegram) |
| `platform.command` | – | **command**, args, collect_ms | **lines** | any allowed slash command + server-line tap |

\* `send.private` on a platform with `features.private_messages = "room"` (Camfrog) needs
`scope.room` in practice; without one the connector uses the room where the user was last seen or
fails with `not_in_room`.

`mic.grab.force` may bump another holder where the platform allows it (v1 `!mic force` blocks the
longest holder). It is a protocol flag, not a permission: modules MUST gate it behind their own
permission checks.

Actions added beyond the §11.2 list, and why:

| added | why (v1 evidence) |
|---|---|
| `send` split + `mention` | v1 splits at ~480 chars and prefixes `@user` on replies. |
| `unban`, `unmute`, `mic.unblock` | automod lifts its own penalties (courtesy unblock, punish expiry, appeals). |
| `role.set` | automod demotes/re-grants roles (`/oplist`, `/addfriend`). |
| `room.list` | v1 multi-room: which rooms are open, which is active, which is the audio room. |
| `cam.open`, `cam.close` | v1 `!cam` opens a user's cam (needed before capture on Camfrog). |
| `cam.self.set` | v1 `cam_control.py` toggles HQ and pause on the bot's own cam. |
| `sticker.send`, `sticker.list` | v1 sends stickers (manual and LLM-chosen) from the local cache. |
| `inbox.read` | v1 `!dms` reads the contact-list inbox. |
| `react` | Discord/Telegram reactions (capability example in §11.2). |
| `platform.command` | escape hatch for slash commands with no PCP equivalent (`/watchlist`) and their server-line answers; keeps PCP small. Allowed commands are listed in `features.platform_commands`. |

## 7. Results and the error model

A result ([`result.schema.json`](../schemas/result.schema.json)) is either `ok: true` with `data`
(validated against `results/<type>.schema.json` when final) or `ok: false` with `error`
([`error.schema.json`](../schemas/error.schema.json)):

```json
{ "code": "rate_limited", "message": "send queue full for LilyPond.Room",
  "retryable": true, "retry_after_ms": 3000, "platform_code": "...", "details": {} }
```

| code | retryable | meaning |
|---|---|---|
| `bad_request` | never | data invalid for this action (also: schema failure) |
| `unauthorized` | no | connection-level auth failure (bye) |
| `forbidden` | no | the bot account lacks the platform permission (not op, not owner) |
| `not_found` | per case | user/room/stream does not exist or is not visible (e.g. off cam) |
| `not_in_room` | yes | the bot is not in the room the action needs |
| `unsupported` | never | action or option not supported by this connector/room |
| `conflict` | yes | state prevents it now (mic full, already joined) |
| `rate_limited` | always | slow down; honour `retry_after_ms` |
| `timeout` | yes | could not start within `timeout_ms`, or the platform did not answer |
| `unavailable` | yes | platform side down (client crashed, gateway disconnected) |
| `payload_too_large` | never | over a limit |
| `cancelled` | no | superseded/cancelled (e.g. connector shutting down before start) |
| `version_unsupported` | never | negotiated version too old for this action/field |
| `session_invalid` | no | resume refused / unknown session (runtime-side completion of orphaned actions) |
| `platform_error` | per case | the platform refused for another reason; see `platform_code` |
| `internal` | per case | connector bug |

`retryable` is authoritative (the table gives defaults; the schemas pin the "always"/"never" rows).
Unknown codes are treated as `internal`, honouring `retryable`. A platform that **accepted** the
request but reports a soft outcome returns `ok: true` with that outcome in data (e.g.
`sticker.send` → `posted: false` when the sticker was rejected; `posted: null` when the room's server
never confirms). Errors are for "the action could not be carried out".

## 8. Capabilities

`hello.data.capabilities` ([`capabilities.schema.json`](../schemas/capabilities.schema.json)):

- `events`: types the connector may emit.
- `actions`: types it executes (anything else → `unsupported`).
- `features`: finer flags — `message_ids`, `threads`, `reactions`, `edits`,
  `content_elements` (outbound element types rendered natively), `private_messages`
  (`room`/`global`/`none`), `display_markup`, `user_id_kind`, `mic.slots`,
  `mic.self_state_observable`, `cam.capture_requires_open`, `sticker_send_ack`
  (`always`/`sometimes`/`never`), `roles`, `platform_commands`.
- `limits`: `message_max_chars`, `send_per_minute`, `max_rooms`, `topic_max_chars`.

**Room-level narrowing.** `room.joined.data.capabilities` MAY list a subset that applies in that
room (a Camfrog room whose server never acks stickers, a single-mic room, a room where the bot is
not an op). Effective capabilities for a scope = the room's set if present, else the connector's.
Features in the room set override connector features key by key.

**Modules check capabilities, never platform names:**

```python
# good
if bot.can("cam.capture", scope):          # action declared for this room
    frame = await bot.call("cam.capture", scope, user=target, open_if_closed=True)
# bad: breaks the day a second platform gets cams
if scope.platform == "camfrog": ...
```

Module manifests declare required capabilities (e.g. the mic-hog module needs events `mic.grab`,
`mic.release` and action `mic.block`); the runtime enables a module only on bindings whose effective
capabilities satisfy them. A capability check that passes does not guarantee success
(permissions can still fail with `forbidden`).

## 9. Message content

Messages carry `text` (always, plain) and optionally `content`: an array of Satori-style elements
([`Element`](../schemas/defs.schema.json)):

| element | fields |
|---|---|
| `text` | `text` |
| `mention` | `user` |
| `mention_all` | `which` = everyone / here / room |
| `emoji` | `name`, `id?`, `media?` (custom emoji, Twitch emotes) |
| `link` | `url`, `text?` |
| `media` | `media` (MediaRef) |
| `sticker` | `sticker` (StickerRef) |
| `quote` | `message_id` |
| `style` | `styles[]` (bold, italic, underline, strike, code, spoiler, color), `color?`, `children[]` |

Unknown element types are allowed (forward compatibility); receivers render them via their `text`
field if present, else skip them.

Outbound: the connector renders element types listed in `features.content_elements` natively and
flattens the rest to text. If both `text` and `content` are given, `content` wins where supported and
`text` is the fallback. Text longer than `limits.message_max_chars` is split by the connector
(sentence/word boundaries) and the result reports `parts`.

Camfrog specifics: chat is plain text (v1 strips markdown before sending); font/colour blobs on
the wire are connector-internal; the server's echo of the bot's own line arrives with shifted fields
and is emitted once as `message` with `self: true`.

## 10. Private messages and the inbox

- `message.private` is a message addressed only to the bot. On Camfrog a PM **arrives through a
  room** (0x60 on that room's socket), belongs to that room (room-level settings and command gating
  apply), and the reply goes back through it: `send.private` with the same `scope.room`. On
  Discord a DM has its own channel (`kind: dm`); Twitch whispers have no room.
- The bot's own sent PMs echo back on Camfrog ("Private message to …"); the connector drops those
  (they are not inbound PMs).
- **Inbox** (Camfrog contact-list DMs) is a different channel: `inbox.notify` (content-free ping)
  and `inbox.read` (on demand; Camfrog reads it from pixels, so results carry `confidence` and may
  lack user ids). Replying to the inbox is not in v1.

## 11. Media

Bytes never ride inside PCP frames except tiny inline payloads. A
[`MediaRef`](../schemas/defs.schema.json) has `kind` (image/audio/video/file), `mime`, and at least
one of:

- `blob`: id of an object in the **runtime blob store**. The connector uploads first, then sends the
  frame that references it: `PUT {runtime}/pcp/v1/blobs/{blob_id}` with the connector's token,
  `Content-Type`, optional `X-Content-SHA256`. The runtime backs this with object storage. Blob ids
  are chosen by the uploader and are unique per connector.
- `url`: any HTTPS location the receiver can fetch (a presigned object-storage URL, a CDN
  attachment, the runtime blob URL). Respect `expires_at`.
- `data`: base64, at most 64 KiB decoded (small stickers, thumbnails).

Plus optional `size`, `width`, `height`, `duration_ms`, `sample_rate`, `channels`, `sha256`, `name`.

| media | produced by | notes |
|---|---|---|
| cam frames | `cam.capture` result | JPEG/PNG, downscaled to `max_width` (Camfrog: 768) |
| stickers | `sticker` event, `sticker.list` | Camfrog: PNG carved from the client's cache (first frame of animated stickers) |
| audio segments | `audio.segment` (audiohook) | WAV; long holds split into `part`s, `final` on the last |
| playback | `audio.play` action | the connector GETs the url / blob and plays it |
| attachments | `message.content[].media` | Discord/Telegram attachments by URL |

Runtime → connector media (TTS for `audio.play`) is a `url` or a `blob` the connector downloads from
the same blob endpoint (`GET`).

## 12. Rate limits and backpressure

Three mechanisms:

1. **Declared limits** (`capabilities.limits`): informative, so the runtime can pace (e.g.
   `send_per_minute`).
2. **Per-action errors**: `rate_limited` with `retry_after_ms` when a specific action can't be
   queued.
3. **`flow` frames** ([`control/flow.schema.json`](../schemas/control/flow.schema.json)), either
   direction, optionally narrowed to a `scope` and/or `action_types`:
   - connector → runtime `slow` (with `max_per_minute`) / `pause` / `resume`: the connector's
     platform-side queue is backing up (Camfrog throttles fast typing; v1 has one serial send worker
     per client) or the platform is down. The runtime MUST stop sending the affected actions on
     `pause` and pace them on `slow`; actions sent anyway MAY fail with `rate_limited`.
   - runtime → connector `pause` / `resume`: the runtime is overloaded. The connector stops sending
     `low`-priority events (buffering them up to its buffer size, then dropping them and reporting
     `sync.gap` `dropped_low_priority`). `normal` and `critical` events and results keep flowing.

Connectors SHOULD bound their action queues (v1 caps TTS at 6 queued jobs and refuses beyond).

## 13. Heartbeats, reconnect and resume

**Heartbeat.** Each side sends `ping` whenever it has sent nothing for `heartbeat_ms`; the peer
answers `pong` with `ref`. A side that sees no frame at all for `2 × heartbeat_ms` treats the
connection as dead and closes with `4008`. Connector pongs report `platform_ok`, so the runtime
can tell "socket fine, Camfrog hook dead" from "everything fine"; a change also produces a
`connector.status` event.

**Acks.** The runtime sends `ack {seq}` (cumulative) at least every `ack_every_events` events or
every heartbeat interval, whichever is first, and only for frames it has durably handled (handed to
the matcher / written to the bus). The connector keeps every unacked event/result in a **replay
buffer** bounded by `replay_window_events` and `replay_window_ms`.

**Reconnect.** The connector reconnects with exponential backoff (1 s, 2 s, 4 s … max 30 s, ±20 %
jitter), honouring `bye.retry_after_ms`.

**Resume.**

1. The connector sends `hello` with `resume.session_id` (and informationally `last_seq_sent`,
   `buffer_from_seq`).
2. If the runtime still has the session, `welcome.resume = {accepted: true, last_seq: N}` where N is
   the last seq it processed. The connector replays every buffered frame with `seq > N`, unchanged
   (same id, seq, ts), then continues with `N'+1`.
3. If the connector no longer holds `N+1` (buffer overflow), it replays what it has and emits
   `sync.gap {reason: buffer_overflow, from_seq: N+1, to_seq: …}`.
4. The runtime re-sends every action of that session that has no final result, **with the same id**.
   Thanks to idempotency (§6) a kick is never executed twice; the connector returns the cached result
   instead. A duplicate final result for an already-finished action is ignored by the runtime.
5. If the runtime refuses (`accepted: false`, unknown/expired session), a new session starts at seq 1;
   the connector emits `sync.gap {reason: resume_rejected}`. The runtime MUST NOT blindly re-send the
   old session's unfinished actions (the connector may have executed them without a cached result);
   it completes them locally with `session_invalid` and lets modules decide.

**Close codes** (WebSocket close frame; a `bye` precedes them when possible):

| code | meaning | reconnect? |
|---|---|---|
| 1000 | normal | per `bye.reconnect` |
| 1001 | going away (shutdown/update) | yes |
| 4000 | protocol error (unparseable frame, invalid control frame) | yes, after fix/backoff |
| 4001 | unauthorized | no |
| 4002 | version unsupported | no |
| 4004 | no hello within 10 s | yes |
| 4008 | heartbeat timeout | yes (resume) |
| 4009 | replaced by a newer connection with the same connector id | no |
| 4013 | overloaded, try later (`retry_after_ms`) | yes |

**Invalid frames.** The runtime logs and acks an invalid event (so replay does not loop) but does
not dispatch it. A connector answers an invalid action with `bad_request`. Invalid control frames
close the connection with `4000`.

## 14. Versioning and extensions

- **MAJOR** = subprotocol (`pcp.v1`). Breaking changes only in a new major; a runtime MAY serve
  several majors on different subprotocols during a migration.
- **MINOR** is negotiated in hello/welcome. Minor versions are **additive only**:
  - new optional fields; new event/action/result types; new enum values in fields documented as
    open (error `code`, element `type`, `features` keys, `MemberGroup`); new close codes in 4xxx.
  - never: removing or renaming fields, making an optional field required, changing a field's type
    or meaning, adding values to closed enums that old receivers must branch on (those need a new
    field instead).
- **Receivers MUST ignore unknown fields and unknown event types** (log at debug). Connectors MUST
  answer unknown action types with `unsupported`. The schemas follow this: objects allow additional
  properties; an unknown `type` only needs a valid envelope (validators report `known: false`).
- **Deprecation:** a field may be marked deprecated in a minor and removed in the next major.
- **Type names**: lowercase dotted segments. Standard types never use `_` inside a segment, so
  runtimes can map `mic_grab` ↔ `mic.grab` unambiguously (the NoneBot2 adapter relies on it).
- **Extensions:**
  - `ext` on users, rooms, media, stickers and every data object: `{ "<platform>": { … } }` for
    platform extras (Twitch badge versions, a Camfrog badge suffix, a raw packet id). Modules MUST
    work without them.
  - Vendor types `x.<platform>.<name>` (e.g. `x.camfrog.cam_viewer_state`) for events/actions
    not worth standardising yet. Promote to a real type in a later minor if a second platform needs it.
- Schema `$id`s carry the major (`…/pcp/v1/…`). The base URL is a placeholder until the repo is
  published (open question).

## 15. Security and privacy

- One token per connector id, rotated from the admin console; tokens only in the upgrade header (or
  hello), never logged. `room.join.password` is `writeOnly`: never logged, never echoed back.
- `message.private` and inbox content MUST NOT be forwarded to public surfaces (bridged web rooms,
  feeds, search). Memory/AI modules that keep PM content keep it private to that user (v1 rule).
- Users who opted out (`!incognito`) are redacted by the runtime before anything leaves it; the
  connector still reports them (it cannot know).
- Connectors report what the platform shows; they MUST NOT derive sensitive traits (Camfrog's
  profile gender bit, for example, is not forwarded).
- Media URLs SHOULD be short-lived; blob ids SHOULD be unguessable.

## 16. Worked examples

Complete, validated sessions live in [`../samples`](../samples). Highlights:

**Command round trip with tracing** ([`camfrog/03-chat-and-commands.json`](../samples/camfrog/03-chat-and-commands.json)):

```json
{"op":"event","id":"c-0202","ts":"2026-10-05T18:02:14.020Z","seq":21,"type":"message",
 "connector":"cf-main",
 "scope":{"platform":"camfrog","room":{"id":"LilyPond.Room","name":"The Lily Pond","kind":"room"}},
 "data":{"message_id":"cf-m-LilyPond.Room-000232","user":{"id":"bogwalker","login":"bogwalker"},"text":"!bal"}}

{"op":"action","id":"r-0201","ts":"2026-10-05T18:02:14.180Z","type":"send",
 "traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
 "scope":{"platform":"camfrog","room":{"id":"LilyPond.Room"}},
 "data":{"text":"you've got 12,400 PAT","mention":{"id":"bogwalker","login":"bogwalker"}},
 "origin":{"bot":"bot-pepe","module":"economy","event":"c-0202"},"timeout_ms":10000}

{"op":"result","id":"c-0203","ts":"2026-10-05T18:02:14.391Z","seq":22,"ref":"r-0201","type":"send",
 "ok":true,"data":{"message_ids":["cf-m-LilyPond.Room-000233"],"parts":1}}
```

**Room PM, display vs login** ([`camfrog/04-private-message.json`](../samples/camfrog/04-private-message.json)):

```json
{"op":"event","id":"c-0301","ts":"2026-10-05T18:05:21.533Z","seq":30,"type":"message.private",
 "connector":"cf-main","scope":{"platform":"camfrog","room":{"id":"LilyPond.Room","kind":"room"}},
 "data":{"user":{"id":"toadstool77","login":"toadstool77","display":"mossy","display_raw":"<b><n>mossy</n></b>"},
         "text":"hey pepe can you not tell the room about my bet"}}
```

**Multi-mic** ([`camfrog/05-mic.json`](../samples/camfrog/05-mic.json)): two `mic.grab` events
with growing `holders`; `mic.grab` action → `conflict` (retryable, `retry_after_ms`); a
`mic.release` with `reason: "lost"` for the bot itself after a timeout.

**Long-running action** ([`camfrog/09-audio.json`](../samples/camfrog/09-audio.json)):
`audio.play` → result `final:false status:queued` → `final:false status:playing` → final
`status:played`.

**Resume** ([`camfrog/12-resume.json`](../samples/camfrog/12-resume.json)): hello with `resume`,
welcome `last_seq: 122`, replay of seq 123–125, a re-sent in-flight `kick` answered from the
cache, then a refused resume followed by `sync.gap`.

**Same model elsewhere**: [`discord/01-session.json`](../samples/discord/01-session.json)
(guild/channel/thread, elements, reactions, DMs, timeouts, `mic.grab` → `unsupported`) and
[`twitch/01-session.json`](../samples/twitch/01-session.json) (emotes, badges as roles, subs as
notices, whispers with no room).

## 17. Camfrog (cf-connector) mapping

How today's Camfrog hook (v1 `frida-bot.py` + `frida-hook.js`, CF10 framing `"CF10" | u32 len |
u32 type | u8 flags | u32-length-prefixed fields`) maps onto PCP. This is the starting table for
work package B-2.

| Camfrog source | PCP |
|---|---|
| c2s 0x00 JOIN (room id) on a new socket + server line "…now logged in" | `room.joined` |
| socket close (closesocket on a room socket), preceded by s2c 0x0A "You were kicked/banned (by …)" | `room.left` (`kicked`/`banned`/`disconnected`) |
| s2c 0x06 ROOM_TEXT with a sender | `message` |
| s2c 0x06 self-echo (text in the nickname field, font blob in the text field) | `message` with `self: true` |
| s2c 0x06 with empty sender (server line) | `notice` + parsed `moderation` / `room.update` |
| room bot chat lines matching moderation patterns | `moderation` with `source: room_bot` |
| s2c 0x60 "Private message from …" (display in markup, login in field 2) | `message.private` (outgoing "to" echo dropped) |
| s2c 0x41 USER_LIST entries (login, display, flags) | `member.join` (`initial` during the join burst), `member.update` |
| owner-drawn user list (WM_DRAWITEM capture, group headers) | `user.list` result, `member.update` (group/on_cam), inferred `member.leave` |
| s2c 0x16 holder heartbeat — onset only | `mic.grab` |
| s2c 0x25 drop (authoritative; naming the bot = lost) | `mic.release` |
| s2c 0x04 / 0x05 keepalive | not forwarded (connector health → `pong.platform_ok`) |
| s2c 0x0d stream setup (user, codec, cam id) | `cam.open` (`stream.id` = cam id) |
| s2c 0x15 / 0x0f viewer of the bot's cam | `cam.view` |
| s2c 0x3f sticker (sender, set id, sticker id) + local cache blob | `sticker` |
| s2c 0x58 sticker ack (status 1/0; only some room servers) | `sticker.send` result `posted` |
| s2c 0x57 DM activity ping | `inbox.notify` |
| Talk button (CButtonTS 1301) BM_CLICK / BM_GETCHECK; c2s 0x07 / 0x08 | `mic.grab` / `mic.release` actions; the bot's own `mic.grab` event |
| c2s 0x06 inject; `/msg`; slash commands | `send`, `send.private`, moderation actions, `platform.command` |
| c2s 0x0d open request; user-list context menu → WM_COMMAND 32000 | `cam.open` action |
| PrintWindow on `VideoViewport` window titled with the user's name | `cam.capture` |
| own-video panel buttons (HQ 2118, pause 2105) | `cam.self.set` |
| Join Room dialog (WM_COMMAND 0x7595, edit 1001, OK 126), MOTD and password prompts | `room.join` |
| WM_SYSCOMMAND SC_CLOSE on the room window (separate-window mode) | `room.leave` |
| "Conversations" window capture + vision | `inbox.read` |

Connector-internal concerns that do **not** surface in PCP: socket fd ↔ room mapping, the
"active room" window the hook drives (exposed only as `room.list[].active`), RPC threading (v1
deadlocks if a synchronous Frida RPC runs on the message-pump thread), offsets and control ids per
client version.

## 18. Open questions

1. **Blob store placement.** Specified as runtime-hosted (connectors dial out and may sit behind
   NAT). Alternative: presigned S3 URLs handed out by the runtime. Confirm with F-2 (MinIO/Garage).
2. **Who owns `audio.play` on Camfrog?** Playback needs both the mic slot (cf-connector) and the
   virtual-mic device (audiohook). The samples have cf-connector declare `audio.play` (audiohook as a
   library inside it); the alternative is the runtime orchestrating `mic.grab` on cf-connector +
   `audio.play` on audiohook. Decide in B-2/B-3.
3. **Camfrog leaves.** No leave packet is known; `member.leave` is inferred from user-list diffs.
   B-2 should `!sniff` a leave to find a native signal.
4. **Soft outcomes vs errors.** `sticker.send` reports a platform rejection as `ok:true,
   posted:false`. Is that the right line, or should rejections be `platform_error`?
5. **`mute.duration_s` on Camfrog** is ignored (server-fixed). Should the connector refuse with
   `unsupported` when a duration is given, or is "advisory" fine?
6. **Schema `$id` base** is the placeholder `https://pepe-botkit.invalid/pcp/v1/`; pick the
   published URL before the repo goes public (the ids are part of the contract).
7. **Multiple bot accounts per platform** (e.g. two Discord bots) = two connector instances. Fine for
   Discord; on Camfrog it means two client installs. Confirm that is acceptable.
8. **Room-level capability narrowing** is a full replacement of `events`/`actions` but a key-wise
   override of `features`. Simple enough, or should it be a diff?
9. **Licence** for the public repo is not chosen yet (packages say `UNLICENSED`).
10. **Ordering across rooms.** Actions are ordered per room only. Does any module need a global
    order (e.g. turf announcements to several rooms at once)?
