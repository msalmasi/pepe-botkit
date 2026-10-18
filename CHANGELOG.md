# Changelog

Protocol versions of PCP. Minor versions are additive only (see
[`spec/PCP.md` §14](spec/PCP.md#14-versioning-and-extensions)); `schemas/index.json` marks each
type with the minor that added it (`since`). Package versions (`@pepe-botkit/pcp-schemas`,
`pcp-schemas`) follow separately.

## 1.1 (draft) — 2026-10-18

For **bridge hubs**: runtimes that also host rooms and relay lines between them and bound rooms on
other platforms. A plain bot runtime can ignore everything below: the one 1.1 event that stands in
for a 1.0 event (`message.reaction` for `reaction`) is sent only to runtimes that subscribe to it
by name. Packages 0.2.0.

### Added

- **Sessions**: `hello.data.bridge{echo_correlation, delivery_ack, history_backfill,
  policy_ttl_ms, result_cache}` for `connector.kind: "bridge"`; `welcome.bindings[]` fields
  `binding, pad, mode, render, filters, policy_v, transcripts, captions, clips, mic_relay,
  room_audio, whispers`; action frame `target` (`{binding}` or `"native"`).
- **Users**: `UserRef.resolved_by`, `unresolved`, `anonymous`, and the rule that unresolved and
  anonymous refs carry session-scoped tokens that are never identities (§4.1).
- **Events**: `message.update`, `message.delete`, `message.reaction`, `privacy.request`,
  `room.state`, `binding.request`, `registry.put`, `interaction`, `typing`, `transcript`,
  `caption.partial`, `bridge.status`. `message` gains `relay_ref`, `webhook_id`,
  `remote_reply_to`; `message.private` gains `whisper{reply_to | to}`.
- **Actions**: `message.edit`, `message.delete`, `message.hide`, `ban.feature.set`,
  `lockdown.set`, `policy.sync`, `modcaps.query`, `interaction.defer`, `interaction.respond`,
  `interaction.followup`, `card.update`, `privacy.forget`, `privacy.export` (with results).
  `send` gains `relay{msg_id, binding, author, otr, hops, render, presplit, part, deadline_ms,
  reply_to_remote}` and the relay rules (§6.1); `send.private` gains `whisper{id, from}` (§10.1);
  `mic.grab` gains `lane`.
- **Results and errors**: `send` result `t{wait_ms, send_ms}`; interim `phase` on `audio.play`
  and `mic.grab` (plus `position`, `eta_ms`, `reason` on `mic.grab`); error codes
  `relay_refused` (with `details.code`), `flood_risk`, `binding_off`, `stale_policy`.
- **Capabilities**: features `message_id_scope`, `edits_own`, `deletes`, `delete_window_s`,
  `reply_refs`, `masquerade`, `relay_prefix`, `reactions_custom`, `reactions_durable`, `typing`,
  `components`, `interactions`, `privacy_edge_filter`, `media.inline_max_bytes`, `pacing{…}`;
  limit `message_max_bytes`.
- **Elements**: `code_block`, `custom_emoji`, `timestamp`, `pad_ref`, `user_ref`, `tip`, `gift`,
  `boost`, `poll`, `card`, `actions`, `embed`, `system`, each with a required `text` rendering.
- **Defs**: `Points`, `Emoji`, `HmacId`, `BindingMode`, `NameSource`, `RelayAuthor`,
  `BindingTarget`, `Phase`, `CmdInvocation`, `Input`.
- **Samples**: `samples/bridge/01…10` (handshake and bindings, relay and echo, policy and privacy,
  room state and moderation caps, edits/deletes/reactions, interactions and cards, whispers, voice,
  hub moderation and routing, 1.0 fallback) and `samples/invalid/27…64` (at least one per 1.1
  type). Tests discover every sample directory, check `since` markers, and check that a session
  negotiated at 1.0 uses only 1.0 types and no 1.1 field (against a frozen copy of the 1.0
  schemas in `compat/pcp-1.0/`).
- **Rules** (draft review): `message.reaction` replaces `reaction` only when `welcome.subscribe`
  names it and not `reaction` (§2.1); a connector with `message_id_scope` `session` or `none`
  sends `message_ids: false`; `relay.author.identities` holds at most the receiving connector's
  own platform; an anonymous `tip`/`gift`/`boost` has `ref` and no `from`/`tx`, a named one
  `from` and `tx`; `custom_id` is 1-64 printable ASCII characters (`CustomId`); a `select` input
  has options; `relay.part` is `1 ≤ n ≤ of`; `policy.sync` identity lists require `hidden_kid`.
  Identity hashes are defined exactly, with a test vector (§15.1). Resume keeps 1.0 step 4 for
  every accepted resume; a `volatile` bridge connector does not resume after a restart (§13).

### Amended (§15, privacy)

- A connector declaring `features.privacy_edge_filter` drops lines, stickers, transcripts,
  captions and turn audio of hidden or opted-out identities at the edge, before anything is
  logged, and reports them only as anonymous presence; never runs speech-to-text for opted-out
  identities or switched-off rooms; never logs `otr` lines or whisper text; purges its own logs on
  `privacy.forget`; fails closed for hub-originated work when its `policy.sync` mirror is stale.
  Identity lists travel as truncated HMAC-SHA256 ids over `platform:id` (no normalisation), with
  out-of-band keys named by `hidden_kid`. A connector without the feature keeps the
  1.0 rule, and the hub drops its events for hidden users at ingest (§15.1).

### Settled

- Open question 1, blob store placement: runtime-hosted `PUT/GET {runtime}/pcp/v1/blobs/{id}`,
  connector-token authenticated, backed by object storage, short-lived signed URLs to receivers
  (§11).

### Compatibility

- Negotiation rules for 1.0 peers in both directions (§2.1). Where a need met a 1.0 field of the
  wrong type, 1.1 adds a field instead of changing it: `features.message_id_scope` beside
  `message_ids`, `edits_own` beside `edits`, `reactions_custom` / `reactions_durable` beside
  `reactions`, `bindings[].room_audio` beside `audio`, result `phase` beside `audio.play.status`.
  The 240 s ceiling on mic and playback waits is hub policy, not a narrowed schema.
- New open questions 11 (`room.state` patch format) and 12 (`policy.sync` key rotation).

## 1.0 (draft) — 2026-10-05

First draft (work package F-4): WebSocket transport (`pcp.v1`), hello/welcome with capability
declaration and version negotiation, the envelope, 22 event types, 27 action types with results
and a structured error model, room-level capability narrowing, Satori-style content elements,
media through a blob store, flow control, heartbeats, acks and resumable sessions with replay,
the Camfrog mapping, JSON Schemas with TypeScript and Python validators, and sample sessions for
Camfrog, Discord and Twitch.
