# PCP — Pepe Connector Protocol, version 1.1 (draft)

Status: **draft 1.1**. 1.1 is an additive minor version of 1.0 (work package F-4 of the v2
rebuild): every 1.0 frame is still valid 1.1, and 1.0 peers keep working through version
negotiation (§2.1). Each 1.1 addition is marked **(1.1)** where it is introduced; the
[changelog](../CHANGELOG.md) lists them. Normative words (MUST, SHOULD, MAY) are used in the
RFC 2119 sense. The JSON Schemas in [`../schemas`](../schemas) are normative for frame shape; this
document is normative for behaviour. Where they disagree, file a bug.

PCP connects a **connector** (a process that speaks one chat platform: Camfrog, Discord, Twitch,
Telegram, the PATV rooms service, or an audio pipeline) to a **bot runtime** (matcher + modules).
Connectors send **events** and execute **actions**; the runtime decides what to do. Modules never
see platform protocols, only PCP, and they check **capabilities**, never platform names.

```
 platform  <--native-->  connector  ==PCP over WebSocket==>  runtime --> matcher --> modules
 (Camfrog client,         (cf-connector,                        (botkit / NoneBot2 adapter)
  Discord gateway, ...)    audiohook, discord-connector, ...)
```

**(1.1)** A **bridge hub** is a runtime that also hosts rooms of its own and relays lines between
them and bound rooms on other platforms (the PATV rooms service is one). Connectors that talk to a
hub declare `connector.kind: "bridge"`. A hub can itself act as a connector towards a bot runtime,
exposing its own rooms (platform `patv` for PATV). The 1.1 additions are mostly what such hubs
need: relay with provenance, policy and privacy mirroring, room state, interactions, edits and
deletes. A plain bot runtime can ignore them: nothing a 1.0 runtime relies on changes. New
event types replace a 1.0 event only when the runtime asks for them by name in
`welcome.subscribe` (`message.reaction`, §5), and new actions and fields are sent only by peers
that use them.

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

**What's new in 1.1** (all additive; [changelog](../CHANGELOG.md)):

- Bridge sessions: `hello.data.bridge`, 1.1 `welcome.bindings[]` fields, the
  [compatibility rules](#21-version-negotiation-and-10-compatibility) and action `target` (§2, §3).
- `UserRef.resolved_by`, `unresolved`, `anonymous` (§4.1).
- Events `message.update`, `message.delete`, `message.reaction`, `privacy.request`, `room.state`,
  `binding.request`, `registry.put`, `interaction`, `typing`, `transcript`, `caption.partial`,
  `bridge.status`; `message` gains `relay_ref`, `webhook_id`, `remote_reply_to`;
  `message.private` gains `whisper` (§5).
- Actions `message.edit`, `message.delete`, `message.hide`, `ban.feature.set`, `lockdown.set`,
  `policy.sync`, `modcaps.query`, `interaction.defer`, `interaction.respond`,
  `interaction.followup`, `card.update`, `privacy.forget`, `privacy.export`; `send.relay`,
  `send.private.whisper`, `mic.grab.lane` (§6).
- Errors `relay_refused`, `flood_risk`, `binding_off`, `stale_policy`; `send` result `t`; interim
  `phase` on `audio.play` and `mic.grab` (§7).
- Features `message_id_scope`, `edits_own`, `deletes`, `delete_window_s`, `reply_refs`,
  `masquerade`, `relay_prefix`, `reactions_custom`, `reactions_durable`, `typing`, `components`,
  `interactions`, `privacy_edge_filter`, `media`, `pacing`; limit `message_max_bytes` (§8).
- Elements `code_block`, `custom_emoji`, `timestamp`, `pad_ref`, `user_ref`, `tip`, `gift`,
  `boost`, `poll`, `card`, `actions`, `embed`, `system` (§9).
- Open question 1 (blob store) settled (§11); the privacy amendment to §15.

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

**(1.1) Bridge connectors** (`connector.kind: "bridge"`, talking to a bridge hub) add
`hello.data.bridge`:

| field | values | meaning |
|---|---|---|
| `echo_correlation` | `job` \| `label` \| `nonce` | how the connector ties a platform echo of a relayed line back to its action: an intermediate queue's job id, a platform request label (IRCv3 `labeled-response`), or a platform send nonce. Echoes are always correlated by id, never by text (§6.1). |
| `delivery_ack` | `on_wire` \| `on_echo` | whether a `send` result is final when the line is written to the platform or when the platform echoes it |
| `history_backfill` | bool | the connector can fetch platform history after an outage |
| `policy_ttl_ms` | int | age after which its `policy.sync` mirror is stale (§15.1) |
| `result_cache` | `durable` \| `volatile` | whether the action result cache (§6 rule 2) survives a connector restart for the replay window. A `durable` connector may resume after a restart; a `volatile` one starts a new session instead, so every accepted resume is safe for the hub's re-send (§13 steps 4 and 6). |

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

**(1.1) Binding fields.** A bridge hub generates `bindings[]` from its own binding table and adds:
`binding` (the binding id; actions may name it in `target`, §3), `pad` (the hub room it feeds, by
slug), `mode` (`ingest` remote → hub only, `relay` both ways, `mirror` hub → remote only, `off`,
`bot_only` no hub room, bots only), `render{style, prefix, font, tags{}}` (how relayed lines look:
a prefix template with `{name}` and `{tag}`, a connector-defined font name, origin platform → tag
text), `filters{in{}, out{}}` (hub-defined keys), `policy_v` (the hub's `policy.sync` version),
the switches `transcripts`, `captions`, `clips`, `mic_relay`, `whispers` (booleans), and
`room_audio` (where the room's audio goes at the hub, hub-defined values, `off` = nowhere). The 1.0
boolean `audio` keeps its meaning; `room_audio` is a new field rather than a new type for `audio`
(§14).

**Version negotiation.** The subprotocol fixes MAJOR. `hello.data.pcp` is the connector's highest
`MAJOR.MINOR`; the runtime answers `MINOR = min(connector, runtime)`. Both sides then MUST NOT send
fields or types introduced after the negotiated minor (receivers ignore them anyway, §14). §2.1
spells out what that means for 1.0 peers.

**One live connection per connector id.** If a connector id connects while another connection with
the same id is live, the runtime closes the OLD one with `4009` (replaced) and continues with the new
one (resuming if asked).

**bye** (either side, [`control/bye.schema.json`](../schemas/control/bye.schema.json)) explains a
deliberate close: `reconnect` (should the peer come back), `retry_after_ms`, and an `error`.

### 2.1 Version negotiation and 1.0 compatibility

(1.1) [`index.json`](../schemas/index.json) records `since: "1.1"` on every type 1.1 added; types
without `since` are 1.0. Fields added in 1.1 are marked "(1.1)" in their schema descriptions.

A **1.1 runtime or hub on a session negotiated at 1.0** (the connector said `pcp: "1.0"`):

1. MUST NOT send 1.1 action types, 1.1 fields (`send.relay`, `send.private.whisper`, `target`,
   `mic.grab.lane`, …) or 1.1 elements. A relayed line goes as a plain 1.0 `send` whose `text` is
   already within `limits.message_max_chars`, or is left for the connector to split (1.0 rule);
   there is no `presplit`.
2. MUST treat the connector as `privacy_edge_filter: false` (§15.1) and read `message_id_scope`
   from the 1.0 boolean: `message_ids: true` → `stable`, otherwise `none`.
3. MUST NOT expect durable reactions (`message.reaction`), `room.state`, `typing` or any other 1.1
   event. Resume follows 1.0 §13 steps 1-5 unchanged: after every accepted resume the runtime
   re-sends the session's unfinished actions with the same ids (step 4).

A **1.1 connector on a session negotiated at 1.0** (the runtime said `pcp: "1.0"`):

1. MUST NOT send 1.1 event types or fields. It falls back to the 1.0 equivalent where one exists
   (`reaction` instead of `message.reaction`), and otherwise omits the event (`typing`,
   `room.state`, `transcript`, …).
2. Still applies everything it promised in its own declaration that makes it safer (an edge
   privacy filter keeps filtering), but reports filtered users with 1.0 fields only (no
   `anonymous` flag: it omits them).

**Replacement events are opt-in on the runtime side.** A 1.1 event that stands in for a 1.0 one
replaces it only when the runtime asks for it by name. A connector declaring
`features.reactions_durable` sends `message.reaction` in place of `reaction` only on a session
negotiated at 1.1 whose `welcome.subscribe` lists `message.reaction` and does not list `reaction`;
if `subscribe` lists both it sends both, and otherwise (no `subscribe`, or one without
`message.reaction`) it keeps sending the 1.0 `reaction`. A runtime that ignores 1.1 events
therefore never loses reactions.

Declarations in `hello` (capabilities, features, the `bridge` block) are sent before negotiation
and may name 1.1 types and features; a 1.0 runtime ignores what it doesn't know (§14).

The hub-side mapping of 1.1 fields that replace 1.0 ones:

| 1.0 field | 1.1 field | rule |
|---|---|---|
| `features.message_ids` (bool) | `features.message_id_scope` (`stable`\|`session`\|`none`) | a 1.1 connector sends both, and sends `message_ids: true` only with `message_id_scope: stable`: a `session` or `none` scope goes with `message_ids: false`, so a 1.0 reader never takes session ids for durable ones. A reader prefers the 1.1 field. |
| `features.edits` (bool, can see edits) | `features.edits_own` (can edit its own) | different questions, both kept |
| `features.reactions` (bool) | `features.reactions_custom`, `features.reactions_durable` | `reactions` still gates `react` and `reaction`; `reaction` stays the default event (below) |
| `welcome.bindings[].audio` (bool) | `welcome.bindings[].room_audio` (string) | both kept |
| `audio.play` result `status` (closed enum) | result `phase` (open) | `status` stays; `phase` adds `waiting` and future steps |

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
| `action` | r → c | `type`, `scope?`, `data`, `timeout_ms?`, `origin?`, `target?` (1.1) |
| `result` | c → r | `seq`, `ref` (action id), `type` (action type, echoed), `ok`, `final?`, `data` or `error` |
| `ack` | r → c | `seq` (cumulative) |
| `ping` / `pong` | both | `pong.ref` = ping id; connector pongs carry `platform_ok`, `last_seq` |
| `flow` | both | `data.state` = `slow` / `pause` / `resume` (§12) |
| `hello` / `welcome` / `bye` | §2 | |

`seq` is assigned by the connector to **every event and result** in a session: starts at 1,
increases by exactly 1, never reused within the session. It drives acks, replay and dedup (§13).

`origin` on an action records who caused it (`bot` instance id, `module`, triggering `event` frame
id, the `user` on whose behalf) for audit logs and for platforms that attribute actions.
`origin.event` is the triggering event frame's id and `origin.user` a `UserRef` in the **target
platform's** namespace (a linked login there, or an opaque hub token).

**(1.1) `target`** routes an action on a bridge hub that serves several bindings in one scope:
`{"binding": "<binding id>"}` acts on that bound remote room only, `"native"` on the hub's own room
only. Absent = the scope's only binding (or the room itself on a plain connector). No new `op`s
were added in 1.1.

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

**(1.1) How a user was resolved.** Three optional fields say how much a `UserRef` can be trusted:

| field | meaning |
|---|---|
| `resolved_by` | `login` (an in-packet login, or one confirmed by the platform's user list in the same tick), `display` (matched by display name), `memory` (remembered from earlier), `unresolved`. Open: an unknown value means "not login-resolved". |
| `unresolved: true` | the connector has only a display name |
| `anonymous: true` | a user reported only as presence (privacy edge filter, §15.1) |

- **Only login-resolved users may act as an account at a hub**: run charged or moderation
  commands, interactions, payments or anything attributed to the person. Lines resolved by display
  name or memory are shown as unverified and may run only free, read-only commands.
- For `unresolved` and `anonymous` users, the connector still fills `id` (it is required), with a
  **session-scoped opaque token**: `~<display>#<session>` for unresolved names, `anon-<hex>` for
  anonymous presence. These tokens are not identities. Receivers MUST NOT create, link or match
  identities on them, and use them for presence and rendering only. This is the 1.0 rule ("never
  invent an `id` from a display name") made explicit for presence.

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
| `message.update` (1.1) | normal | ✓ | **message_id**, **text**, user, content, edited_at | An author edited a message on the platform (needs `features.edits`). `text`/`content` are the new full message. |
| `message.delete` (1.1) | normal | ✓ | **message_id**, user, deleted_by, verified | `verified: true` when the connector confirmed who deleted it (Discord: the audit log). Only a verified author delete counts as the author's own. |
| `message.reaction` (1.1) | normal | ✓ | **message_id**, **emoji**, **user**, **op**, count | Needs `features.reactions_durable`. Sent in place of `reaction` only when `welcome.subscribe` lists `message.reaction` and not `reaction` (both when it lists both); otherwise the connector keeps sending `reaction` (§2.1). `count` = the platform's total for that emoji after the change. |
| `privacy.request` (1.1) | normal | – | **identity**, **kind**, flag, value, code | A user asked, on the platform, for a hub privacy action: `flag` (`incognito`, `bridge_hide`, `caption_optout`, `transcripts_optout`, with `value`), `export`, `forget_public`, `prove` (with the `code` they typed). Login-resolved users only; the hub answers privately with `send.private`. |
| `room.state` (1.1) | normal | ✓ | **v**, full, switches, menu, bot_menu, roster_fresh, stage, settings, masters_off, lang | Room state the connector applies (below). |
| `binding.request` (1.1) | normal | ✓ | **mode**, **user**, binding | A user asked on the platform to change how the hub uses this room (a room owner typing a bridge command). The hub applies it only if `user` is the proven owner of the remote room. |
| `registry.put` (1.1) | normal | – | **commands**, full | The connector's command menu as untyped manifests (`name`, `aliases`, `summary`, `usage`, `price`, `roles`, `hidden`), so a hub can offer them in its own UI. |
| `interaction` (1.1) | normal | ✓ | **interaction_id**, **kind**, **user**, command, options, custom_id, values, message_id, deadline_ms, expect | A user ran a command or used a component through the platform UI (slash command, button, select, modal). Answered with `interaction.*` actions before `deadline_ms`. `expect.price` is what the user saw, so a changed price is refused. |
| `typing` (1.1) | low | ✓ | **user**, on | Needs `features.typing`. |
| `transcript` (1.1) | normal | ✓ | **utt_id**, **t0**, **t1**, **text**, speaker, lang, prob, source, attribution, confidence | Final transcript of one mic turn, made at the connector. `t0`/`t1` are the turn's own times; receivers dedupe on (room, `utt_id`). Subject to §15.1. |
| `caption.partial` (1.1) | low | ✓ | **utt_id**, **text**, speaker, lang, t0, media_ts | Live partial caption; later partials with the same `utt_id` replace it. `media_ts` = capture time of the audio, for delayed streams. Subject to §15.1. |
| `bridge.status` (1.1) | critical | – | **state**, binding, reason, effective | State of one binding, or of the hub link as a whole without `binding` (`ok`, `degraded`, `down`, `paused`; open). `effective` = the values in force, connector-local overrides included (hub-defined keys). |

**(1.1) Fields added to 1.0 events.**

- `message`: `relay_ref` (on a self line: the id of the relay action, or the job, this echo
  answers; §6.1), `webhook_id` (sent through a platform webhook; hubs drop lines from their own
  webhooks), `remote_reply_to` (the platform's reply target when it is not a `message_id` this
  session reported, e.g. an older message; the hub resolves it through its id map). Platform
  extras such as a Camfrog line's font go in `ext.<platform>` (§17).
- `message.private`: `whisper{reply_to | to}`: a reply to a hub whisper (§10.1), naming either the
  whisper answered (`reply_to`, the user's "reply" command) or the hub user (`to`, a handle or
  display name as typed).

**(1.1) `room.state`** replaces ad-hoc state reports for bound rooms. `full: true` is a complete
snapshot; otherwise the data is an RFC 7386 JSON Merge Patch of the previous state (`null` removes
a key). `v` increases by exactly 1 per room; a receiver that sees a gap ignores patches until the
next full snapshot. The connector sends a full snapshot on `room.joined`, on session start and
resume, and at least every 30 s. Fields: `switches{name: bool}` (feature switches as the connector
applies them; hub-defined names), `menu{command: price}` and `bot_menu{action: {on, price}}`
(prices are points as decimal strings, `"0"` = free), `roster_fresh{list_at, list_fresh,
list_stale_after, seen_ttl}` (how fresh the member list is; durations in seconds), `stage`
(connector-defined), `settings{key: {v, by}}`, `masters_off[]` (settings the room owner locked
off), `lang{chat, stt, tts, tts_effective}`. A hub that disagrees with an echoed consent switch for
more than 60 s treats it as off.

**Vendor events.** Connectors may also emit `x.<vendor>.*` events (unchanged §14 rule), for
example a hub's live-cam state or a connector-level room list, with no standard schema.

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
| `message.edit` (1.1) | ✓ | **message_id**, **text** or **content** | message_ids | needs `features.edits_own` (not Camfrog) |
| `message.delete` (1.1) | ✓ | **message_id**, reason | – | `features.deletes` `own`/`any`; past `delete_window_s` → `unsupported` |
| `message.hide` (1.1) | ✓ | **message_id**, on, reason | – | rooms the connector hosts (a hub's own rooms): reversible hide |
| `ban.feature.set` (1.1) | ✓ | **user**, **feature**, **on**, duration_s, reason | – | rooms the connector hosts: ban from one feature (`chat`, `commands`, `voice`, `media`, …; open) or lift it |
| `lockdown.set` (1.1) | ✓ | **level**, duration_s, reason | – | rooms the connector hosts: who may speak (`off`, `new_accounts`, `verified`, `members`, `mods`; open) |
| `policy.sync` (1.1) | ✓ | **v**, full, bans, lockdown, hidden, hidden_kid, caption_optout, transcripts_optout, switches, cmd_deny | **v** | the hub's policy mirror for one bound room (§15.1) |
| `modcaps.query` (1.1) | ✓ | **users** (≤ 60 ids) | **caps** {id: {actions, roles, admin, blocked, …}} | which of the given platform users have moderation powers in the room; users without powers are omitted |
| `interaction.defer` (1.1) | – | **interaction_id**, ephemeral | – | acknowledge now, answer later |
| `interaction.respond` (1.1) | – | **interaction_id**, **text** or **content**, ephemeral | message_ids | the answer |
| `interaction.followup` (1.1) | – | **interaction_id**, **text** or **content**, ephemeral | message_ids | a further message |
| `card.update` (1.1) | ✓ | **ref**, **v**, **patch** or **layout**, text, closed | – | edit a posted `card`/`poll` element (§9) |
| `privacy.forget` (1.1) | – | **identities** | **purged** | purge the connector's own logs, caches and memory for these users |
| `privacy.export` (1.1) | – | **identities** | **records**, media | collect what the connector holds about them (a blob, §11) |

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

**(1.1) Fields added to 1.0 actions.**

- `send.relay`: present when a bridge hub relays a person's line (§6.1).
- `send.private.whisper{id, from}`: a hub user's whisper to this user (§10.1).
- `mic.grab.lane: true`: the grab carries a hub speaker's live audio (a mic lane) rather than the
  bot's own. Interim results report `phase` (`queued`, `waiting`, `live`, `lost`, `grab_pending`,
  `grab_failed`; open), `position`, `eta_ms` and, on failure, `reason`. A grab takes only a slot
  that has been free for a moment, and a connector that sees repeated lost races or swallowed
  clicks reports `grab_failed` with its cool-down reason instead of retrying blindly.
- `audio.play` interim results add `phase` (`queued`, `waiting` for a free slot, `playing`,
  `played`, `dropped`; open) beside the 1.0 `status`. Hubs cap `wait_for_slot_ms` and
  `mic.grab.wait_ms` at 240 000 ms; that ceiling is hub policy, not a schema limit (narrowing a
  1.0 field would not be additive).

Moderation actions (`message.hide`, `ban.feature.set`, `lockdown.set`) are standard types for any
connector that hosts rooms itself, typically a bridge hub acting as a connector towards a bot
runtime; they are declared in capabilities like every action. Room control keeps the 1.0
`room.join` (`password` is `writeOnly` and used once) and `room.leave`; anything platform-specific
(desired-state pushes, owner settings) is an `x.<vendor>.*` action.

**(1.1) Interactions.** An `interaction` event MUST be acknowledged (`interaction.defer` or
`interaction.respond`) before its `deadline_ms`; the connector shows the platform's failure state
otherwise. Runtimes refuse interactions whose `expect.price` no longer matches, and never run
interactions from lines that are late or replayed (§13). `custom_id`s are
`module:entity:verb:version` in 1-64 printable ASCII characters (`!` to `~`), so characters equal
bytes and they pass Telegram `callback_data` (64 bytes) unchanged.

### 6.1 Relay (1.1)

A bridge hub relays a person's line as a `send` with a `relay` block:

| field | meaning |
|---|---|
| **msg_id**, **binding** | the line's id at the hub, and the binding |
| **author** | `{acct, name, name_src, display, handle, tag, avatar_url, verified, identities{}}`: `name_src` is `display` (the hub display name), `login` (the author's linked login on this platform) or `handle` (their unique hub handle); `identities` = at most one entry, the author's linked identity on the receiving connector's own platform (`{"<platform>": "<external id>"}`), so the connector can apply its own per-user checks (ignore lists, timeouts). Hubs MUST NOT send an author's links to other platforms (§15.1). |
| otr | off the record |
| hops | 0 = native line, 1 = already bridged once (never relayed further) |
| render | render style (open): `prefix`, `masquerade`, `bot` |
| presplit, part{n, of} | the hub split the line; one action per part, `1 ≤ n ≤ of` |
| deadline_ms | give up (`timeout`) if not sent within this time of receipt |
| reply_to_remote | platform message id to reply to natively (`features.reply_refs`) |

Rules:

1. **Ids correlate.** A relay action's id is `relay:<msg_id>:<binding>[:p<n>]`; a bot action
   executed on a platform is `bot:<action id>`. The platform echo comes back as `message` with
   `self: true` and `relay_ref` = that id (correlated through `hello.bridge.echo_correlation`).
   A hub marks a `relay:` echo delivered and does not ingest it. A self line **without**
   `relay_ref` is the bot's own native output.
2. **Names.** The connector renders `{name}` from `author.name` only, never from
   `author.display`: the hub has already checked the name for collisions.
3. **Splitting.** With `presplit: true` the hub has split the line and each part fits one platform
   line, prefix included; the connector MUST NOT split again. A part over the limit is refused with
   `relay_refused` (`details.code: "too_long"`). Bot-authored `send`s (no `relay`) keep 1.0's
   connector-side split.
4. **Pacing has one owner, the hub.** It releases one relay action per room at a time in fair
   order, from the connector's declared `features.pacing`. The connector executes actions FIFO per
   room (§6 rule 5), applies only its global gap and flood guard, never re-orders, never applies its
   own per-sender fairness or a second expiry, and sends no interim "paced" results.
5. **Off the record.** A connector receiving `otr: true` MUST NOT write the line to its logs or
   memory.
6. **Refusals.** A connector that applies its own side of a check (the author is ignored or timed
   out there) answers `relay_refused` with its reason in `details.code` (e.g. `account`).
7. **Outcomes.** `binding_off`: relay is switched off for that room; `flood_risk`: sending now
   would trip the platform's flood protection; `stale_policy`: the policy mirror is stale (§15.1).
   A timeout after the platform may have accepted the line is ambiguous; hubs record it as
   unconfirmed and never re-send it.

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
| `relay_refused` (1.1) | never | the connector refused a relayed line or whisper on its own side; `details.code` says why (`too_long` for an oversized presplit part, `account` for an author it won't carry, …) |
| `flood_risk` (1.1) | yes | sending now would trip the platform's flood protection |
| `binding_off` (1.1) | yes | relay is switched off for this room on the connector's side |
| `stale_policy` (1.1) | yes | the connector's `policy.sync` mirror is older than `policy_ttl_ms`; hub-originated work is refused until it is refreshed (§15.1) |

**(1.1)** The `send` result keeps 1.0's `message_ids[]` (one per platform message) and `parts`,
and adds `t{wait_ms, send_ms}` (time in the connector's queue, time of the platform call). A
whisper to a user who is not present fails with `not_found` and `details.code: "not_present"`.

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

**(1.1) Features and limits:**

| key | meaning |
|---|---|
| `message_id_scope` | `stable` (durable platform ids), `session` (unique only within one connector session, e.g. Camfrog's `cf-m-<session>-<room>-<seq>`), `none`. Hubs dedupe inbound lines on `message_id` only when `stable`; otherwise on the event key. |
| `edits_own` | the bot can edit its own messages (`message.edit`) |
| `deletes` | `own` \| `any` \| `none`: what `message.delete` can remove |
| `delete_window_s` | older messages can't be deleted (Telegram: 172 800) |
| `reply_refs` | `reply_to` / `relay.reply_to_remote` produce native replies |
| `masquerade` | relayed lines can carry the author's name and avatar natively (Discord webhooks) |
| `relay_prefix` | relayed lines are rendered with a text prefix (`render.prefix`) |
| `reactions_custom` | custom emoji can be used in reactions |
| `reactions_durable` | the connector can report reactions per user as `message.reaction` (normal priority). It does so in place of `reaction` only when the runtime subscribes to `message.reaction` and not to `reaction` (§2.1); otherwise it keeps sending `reaction`. |
| `typing` | the connector emits `typing` |
| `components` | `card` and `actions` elements render natively (buttons, selects) |
| `interactions` | the connector emits `interaction` and executes `interaction.*` |
| `privacy_edge_filter` | the connector applies §15.1. Absent = false. |
| `media.inline_max_bytes` | largest attachment posted natively; bigger media goes as a link |
| `pacing{gap_ms, burst, window_ms, room_gap_ms, room_burst, room_window_ms, global_gap_ms, webhook_burst, webhook_window_ms, dup_window_ms}` | the platform's send limits, so a hub can pace relayed lines (§6.1 rule 4): per sender (`gap_ms`, `burst` per `window_ms`), per room, per account, per webhook, and `dup_window_ms` (the platform drops a line identical to one sent within it) |
| `limits.message_max_bytes` | line limit in UTF-8 bytes, for platforms that count bytes (IRC); hubs size relay parts with it |

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

**(1.1) Elements.** Each carries a plain-text rendering in `text` (required), so 1.0 receivers and
connectors that do not render the type natively show that instead:

| element | fields |
|---|---|
| `code_block` | `text`, `lang?` |
| `custom_emoji` | `id`, `name`, `pack?`, `animated?`, `media?` |
| `timestamp` | `at` (RFC 3339), `fmt?` (display hint: `t T d D f F R`, open) |
| `pad_ref` | `slug`: a room on a bridge hub |
| `user_ref` | `user` (UserRef): a link to a user's card |
| `tip`, `gift`, `boost` | `amount` (points, decimal string), `to` (tip, gift), `from` + `tx` (giver and ledger reference) **or** `ref` (an anonymous giver: an opaque reference, and then no `from` and no `tx`), `item?`, `pad?`, `note?` |
| `card`, `poll` | `ref` (card id), `v` (version), `cl` (layout language version, 1 = first), `layout` (≤ 6 KB), `state` (≤ 2 KB); `layout` and `state` are opaque to PCP |
| `actions` | `rows` (≤ 2 rows of ≤ 5 inputs `{b: button\|select\|amount, custom_id, cmd{name, sub?, opts?}, label_key?, label?, style?, price?, options?}`; a `select` has at least one option; `custom_id` as in §6), `ttl_s?` |
| `embed` | `url`, `kind?`, `title?`, `desc?`, `site?`, `thumb?` (MediaRef) |
| `system` | `key` (dotted, e.g. `topic.set`), `args` |

- Every `actions` input carries `cmd`, the command a platform without components types instead,
  and the element's `text` names it. Connectors with `features.components` render `card` and
  `actions` natively (and edit them on `card.update`); others post `text` and ignore `actions`.
- Card edits SHOULD be coalesced to one per card per 5 s; text-only platforms get a card only
  when it is posted and when it closes (`card.update.closed`).
- Hubs MAY emit simpler 1.0 elements where those render better on the target (for example an
  `embed` as a `link`, a `custom_emoji` as `emoji` with `name: ":name:"`); `embed` and
  `custom_emoji` are defined for other runtimes and for inbound use.
- Stickers keep `StickerRef`; platform details go in `ext.<platform>` (a Camfrog sticker:
  `ext.camfrog{pack, id, desc}`, §17).
- Amounts are **points** (a hub's in-chat unit), never money.

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

### 10.1 Whispers (1.1)

A **whisper** is a private message between a hub user and a user in a bound room, carried by the
bot as a PM.

- **Hub → platform:** `send.private` with `whisper{id, from}` (`from` is a relay author: `name`,
  `name_src`, `handle`, `tag`, `acct`; its `identities`, if any, hold only the connector's own
  platform, as in §6.1). The action id is `whisper:<id>:<binding>`. It rides the
  room's lane like a relay line. It **never falls back to a room send**: a target who is not
  present fails with `not_found` (`details.code: "not_present"`) and nothing is queued.
- **Platform → hub:** a user replies through the bot (on Camfrog, a PM to the bot with a "reply"
  or "whisper to" command). The connector forwards it as `message.private` with
  `whisper{reply_to}` (the whisper answered) or `whisper{to}` (the hub user named, as typed). PM
  packets carry the real login, so these are login-resolved.
- The connector treats whisper text like `otr`: never written to logs, memory or any room.

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

**(1.1) Blob store (open question 1, settled).** The runtime, or a bridge hub acting as runtime,
hosts the blob store at `PUT/GET {runtime}/pcp/v1/blobs/{id}`, authenticated by the connector
token and backed by object storage. Connectors upload clips, snapshots and exports there; receivers
get short-lived signed `MediaRef.url`s and never raw storage URLs.

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

**(1.1)** A hub that releases one relay action per room at a time (§6.1) gets no interim "paced"
results: the connector's queue never holds more than one relay line per room. Interim results
remain for long actions (`audio.play`, `mic.grab`). A connector whose platform side stalls while
its WebSocket stays up (for example the bot process behind it stops ticking) sends `flow` `pause`
and `bridge.status` `degraded`, keeps forwarding events it already captured, and sends `resume`
when the platform side is back.

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
6. **(1.1) Bridge hubs** persist sessions, so a resume still succeeds after the hub fails over to
   another instance. Step 4 applies to every accepted resume, as in 1.0: an accepted resume means
   the connector still holds its replay buffer and result cache. A connector that declared
   `hello.bridge.result_cache: volatile` and restarted its process MUST NOT ask to resume; it
   starts a new session (step 5). When a bridge connector starts a new session (no resume, or a
   refused one), the hub never re-sends the old session's unfinished actions and records an action
   whose outcome is unknown as unconfirmed. The hub sends `ack` only after the event is durable on
   its side (committed or written to its log). Replayed events may be old: bridge hubs never
   dispatch commands or interactions from events whose envelope `ts` (frame creation time,
   unchanged on replay) is more than 60 s old, and other runtimes SHOULD apply the same rule.

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
- **(1.1)** [`index.json`](../schemas/index.json) marks each type with the minor that added it
  (`since`; absent = 1.0), so validators and tests can check that a session negotiated at an older
  minor uses only its types (§2.1).

**Worked example: why 1.1 adds fields instead of changing them.** Several bridge needs met 1.0
fields of the wrong type. A minor never changes a type, so:

| need | 1.0 field (kept) | 1.1 addition |
|---|---|---|
| message ids that are only unique per session | `features.message_ids: bool` | `features.message_id_scope: stable\|session\|none` |
| the bot can edit its own messages | `features.edits: bool` (sees edits) | `features.edits_own` |
| custom and durable reactions | `features.reactions: bool` | `reactions_custom`, `reactions_durable` (and a new event, `message.reaction`, rather than a priority change on `reaction`) |
| where a bound room's audio goes | `bindings[].audio: bool` | `bindings[].room_audio: string` |
| a `waiting` step for playback | `audio.play` `status` (closed enum) | `phase` (open string) |
| a 240 s wait ceiling | `wait_for_slot_ms`, `wait_ms` (unbounded) | none: a hub rule, since narrowing a 1.0 field is not additive |
| an author's account at a hub | `UserRef.ext.<platform>` | generic `resolved_by`, `unresolved`, `anonymous`; hub-specific account ids stay in `ext.<hub platform>` |

## 15. Security and privacy

- One token per connector id, rotated from the admin console; tokens only in the upgrade header (or
  hello), never logged. `room.join.password` is `writeOnly`: never logged, never echoed back.
- `message.private` and inbox content MUST NOT be forwarded to public surfaces (bridged web rooms,
  feeds, search). Memory/AI modules that keep PM content keep it private to that user (v1 rule).
- Users who opted out (`!incognito`) are redacted by the runtime before anything leaves it; the
  connector still reports them (it cannot know). **(1.1)** This remains the rule for connectors
  without `features.privacy_edge_filter`; connectors that declare it follow §15.1 instead.
- Connectors report what the platform shows; they MUST NOT derive sensitive traits (Camfrog's
  profile gender bit, for example, is not forwarded).
- Media URLs SHOULD be short-lived; blob ids SHOULD be unguessable.

### 15.1 Privacy edge filter and policy mirror (1.1, amends §15)

PCP 1.0 has the connector report everyone and the runtime redact. With bridges, that means a hidden
user's lines reach the hub (and its logs) before anything can drop them. 1.1 moves the filter to
the edge for connectors that can apply it.

**The mirror.** A hub sends `policy.sync` per bound room and the connector acks with its `v`.
`full: true` replaces the whole mirror; otherwise each present field replaces that field. It
carries feature `bans[]`, the `lockdown` level, per-room `switches{}` (e.g. `relay`,
`transcripts`, `captions`, `clips`, `whispers`), the command deny list `cmd_deny[]`, and three
identity lists: `hidden[]`, `caption_optout[]`, `transcripts_optout[]`. Identities in those lists
are never sent in clear, and only identities on the connector's own platform are listed. Per-viewer
ignores and anything else about hub users never reach the edge.

**Identity hashes.** Each list item is

```
lower_hex(HMAC-SHA256(key, utf8(platform + ":" + id)))[0:20]
```

where `platform` is the connector's platform name (`hello.data.connector.platform`) and `id` is
the `UserRef.id` exactly as this connector reports it in its own events: no case folding, trimming
or other normalisation (on Camfrog the id is the lowercased login, so the hash uses that, not the
`login` spelling). The connector checks a user by computing the same hash over the id it is about
to report.

- **Keys** are byte strings provisioned out of band with the connector's credentials (like the
  hello token, from the hub's admin console) and never travel in PCP frames. Each key has its own
  id, the kid.
- `hidden_kid` names the key every identity list in that `policy.sync` uses; a frame that carries
  `hidden`, `caption_optout` or `transcripts_optout` MUST carry `hidden_kid`.
- **Rotation.** The hub provisions the next key (with its kid) before it starts using it. The
  connector keeps the key of its current mirror until a full `policy.sync` names the new kid, so
  during a rotation it holds the current and the previous key. A mirror naming a kid the connector
  does not hold is stale (rule 6 below): the connector refuses hub-originated work with
  `stale_policy` until it is provisioned.
- **Test vector.** key = the 16 ASCII bytes `pcp-1.1-test-key`, platform `camfrog`, id
  `lilypadlou`: the item is `f84004d41a6a8ddaf206`. (With id `LilyPadLou` it would be
  `59f5b268a7e190753538`, which is why the id is never normalised by either side.)

**A connector that declares `features.privacy_edge_filter`:**

1. drops at the edge every line, sticker, transcript, caption and turn-audio blob of an identity
   in `hidden[]` or opted out on its own platform, **before** anything is logged, recorded,
   remembered or transcribed;
2. reports such users only as `anonymous: true` presence (§4.1), never with their id or name;
3. never runs speech-to-text for identities in `transcripts_optout[]` or `caption_optout[]`, for
   speakers it cannot attribute confidently while such an identity is present, or in rooms whose
   `transcripts` / `captions` switches are off; it reports the switches it applies in
   `room.state`;
4. never writes `otr` lines or whisper text to its logs or memory (§6.1, §10.1);
5. purges its own logs and caches for the given identities on `privacy.forget`, and returns what it
   holds on `privacy.export`;
6. treats its mirror as **stale** when it is older than `hello.bridge.policy_ttl_ms`: it reports
   `connector.status` / `bridge.status` `degraded` and refuses hub-originated work (relay sends,
   interactions, hub room control, hub-pushed moderation, mic-lane grabs) with `stale_policy`,
   while its platform-native features (commands typed on the platform, the bot's own games and
   music) keep running on the last mirror with bans enforced from cache. Ingest continues; the hub
   re-checks everything.

**A connector without it** keeps 1.0 behaviour (it reports everyone). A hub MUST then drop that
connector's events for hidden or opted-out identities at ingest, before any write or log, and
SHOULD show "edge privacy filter missing" on its bindings. A hub also drops any transcript,
caption or turn audio from a room whose switch is off or attributed to an opted-out identity,
whatever the connector declared.

**Privacy requests from the platform.** `privacy.request` lets a login-resolved user set a privacy
flag, ask for an export, have their public lines forgotten, or prove an identity link, by typing a
command where they are. The hub answers privately (`send.private`).

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

**(1.1) Relay and its echo** ([`bridge/02-relay-echo.json`](../samples/bridge/02-relay-echo.json)):
the first part of a pre-split line, its result with timing, and the platform echo correlated by
`relay_ref`:

```json
{"op":"action","id":"relay:0192f3c4-7a1e-7c2b-9d10-5e6f7a8b9c0d:bnd-cf-lilypond:p1","ts":"2026-10-18T18:01:00.040Z",
 "type":"send","scope":{"platform":"camfrog","room":{"id":"LilyPond.Room","name":"The Lily Pond","kind":"room"}},
 "data":{"text":"🌐 Mia (web): the first half of a long line, …",
         "relay":{"msg_id":"0192f3c4-7a1e-7c2b-9d10-5e6f7a8b9c0d","binding":"bnd-cf-lilypond",
                  "author":{"acct":"acct-9f2c","name":"Mia","name_src":"display","tag":"web","verified":true,
                            "identities":{"camfrog":"mia_k"}},
                  "otr":false,"hops":0,"render":"prefix","presplit":true,"part":{"n":1,"of":2},"deadline_ms":29360}},
 "timeout_ms":29360,"origin":{"bot":"hub","module":"relay"}}

{"op":"result","id":"c-3201","ts":"2026-10-18T18:01:00.080Z","seq":6,
 "ref":"relay:0192f3c4-7a1e-7c2b-9d10-5e6f7a8b9c0d:bnd-cf-lilypond:p1","type":"send","ok":true,
 "data":{"message_ids":["cf-m-3f9a2c1d7e4b-LilyPond.Room-88219"],"parts":1,"t":{"wait_ms":640,"send_ms":35}}}

{"op":"event","id":"c-3202","ts":"2026-10-18T18:01:00.120Z","seq":7,"type":"message","connector":"cf-main",
 "scope":{"platform":"camfrog","room":{"id":"LilyPond.Room","name":"The Lily Pond","kind":"room"}},
 "data":{"message_id":"cf-m-3f9a2c1d7e4b-LilyPond.Room-88219","user":{"id":"pepebot","login":"PepeBot","is_self":true},
         "text":"🌐 Mia (web): the first half of a long line, …","self":true,
         "relay_ref":"relay:0192f3c4-7a1e-7c2b-9d10-5e6f7a8b9c0d:bnd-cf-lilypond:p1"}}
```

**(1.1) Policy mirror** ([`bridge/03-policy-privacy.json`](../samples/bridge/03-policy-privacy.json)):

```json
{"op":"action","id":"r-3301","ts":"2026-10-18T18:02:00.040Z","type":"policy.sync",
 "scope":{"platform":"camfrog","room":{"id":"LilyPond.Room"}},
 "data":{"v":41,"full":true,"bans":[{"user":{"id":"spamfrog","login":"spamfrog"},"feature":"chat","expires_at":"2026-10-19T18:00:00.000Z"}],
         "lockdown":"off","hidden":["3fa91c0b7d2e4a6c8e10","aa01bb02cc03dd04ee05"],"hidden_kid":"k-2026q4",
         "caption_optout":[],"transcripts_optout":["0f1e2d3c4b5a69788796"],
         "switches":{"relay":true,"transcripts":true,"captions":false,"clips":true,"whispers":true},"cmd_deny":["roast"]}}

{"op":"result","id":"c-3301","ts":"2026-10-18T18:02:00.080Z","seq":20,"ref":"r-3301","type":"policy.sync","ok":true,"data":{"v":41}}
```

**(1.1) A privacy request typed in the room** (same file):

```json
{"op":"event","id":"c-3308","ts":"2026-10-18T18:02:00.400Z","seq":27,"type":"privacy.request","connector":"cf-main",
 "scope":{"platform":"camfrog"},
 "data":{"identity":{"id":"toadstool77","login":"toadstool77","display":"mossy","resolved_by":"login"},
         "kind":"flag","flag":"transcripts_optout","value":true}}
```

The other bridge samples cover the 1.1 handshake and bindings, room state and moderation caps,
Discord edits, deletes and durable reactions, interactions and cards, whispers, voice, hub
moderation with `target`, and the 1.0 fallback ([`bridge/`](../samples/bridge)).

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
| (1.1) chat line ids | `message_id` = `cf-m-<session>-<room>-<seq>` (`message_id_scope: session`): `<room>` is the room id with every character outside the `Id` alphabet replaced by `-`, or the first 16 hex characters of its SHA-256 when the id would pass 128 characters |
| (1.1) s2c 0x06 font blob on a login-resolved line | `message.ext.camfrog.font{face, color}` (parsed; never raw markup) |
| (1.1) s2c 0x60 PM "reply" / "whisper to" commands | `message.private` with `whisper{reply_to \| to}` |
| (1.1) s2c 0x3f sticker | `sticker` with `StickerRef.ext.camfrog{pack, id, desc}`; `desc` from a vision pass, the art itself is never forwarded |
| (1.1) relayed lines | `send` with `relay`: prefix render in a relay font, `{name}` from `author.name`; echoes come back with `relay_ref` |

Connector-internal concerns that do **not** surface in PCP: socket fd ↔ room mapping, the
"active room" window the hook drives (exposed only as `room.list[].active`), RPC threading (v1
deadlocks if a synchronous Frida RPC runs on the message-pump thread), offsets and control ids per
client version.

## 18. Open questions

1. **Blob store placement.** *Settled in 1.1* (§11): runtime-hosted at `{runtime}/pcp/v1/blobs/{id}`,
   connector-token authenticated, backed by object storage; receivers get short-lived signed URLs.
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
6. **Schema `$id` base** is the placeholder `https://github.com/msalmasi/pepe-botkit/pcp/v1/`; pick the
   published URL before the repo goes public (the ids are part of the contract).
7. **Multiple bot accounts per platform** (e.g. two Discord bots) = two connector instances. Fine for
   Discord; on Camfrog it means two client installs. Confirm that is acceptable.
8. **Room-level capability narrowing** is a full replacement of `events`/`actions` but a key-wise
   override of `features`. Simple enough, or should it be a diff?
9. **Licence**: decided — MIT (see `LICENSE`).
10. **Ordering across rooms.** Actions are ordered per room only. Does any module need a global
    order (e.g. turf announcements to several rooms at once)?
11. **`room.state` patches** (1.1) use RFC 7386 JSON Merge Patch, which cannot express array edits
    or set a value to `null`. Should they move to RFC 6902 JSON Patch?
12. **`policy.sync` key rotation** (1.1): keys are provisioned out of band with a kid each, and a
    mirror naming a kid the connector does not hold is stale (§15.1). Should there be an explicit
    in-band key-rotation handshake action as well?
