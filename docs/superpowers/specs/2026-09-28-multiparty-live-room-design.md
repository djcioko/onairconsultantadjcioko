# DJCIOKOSTUDIO Multiparty Live Room Design

**Date:** 2026-09-28  
**Status:** Approved by the user on 2026-09-28
**Frontend repository:** `djcioko/onairconsultantadjcioko`  
**Capacity:** 9 participants total: 1 host and at most 8 accepted guests

## 1. Purpose

Add a moderated, TikTok-Live-style interactive video room without changing the existing public LIVE experience. A visitor on `djcioko.ro` chooses or enters a display name, raises a hand, and waits for the host to accept or decline the request. Accepted guests and the host see one another in a responsive video grid and can control their own microphone, camera, and departure.

The interactive room is private to the host and accepted participants. Public viewers continue to receive the existing public LIVE program and do not see or hear the multiparty grid.

## 2. Success Criteria

- The current public LIVE continues to connect, play, count viewers, reconnect, and stop as it does before this feature.
- The host sees named requests and can accept, decline, remove one participant, or close the room.
- The room never contains more than 9 total participants, including the host.
- Every connected participant can see every other connected participant, with a displayed name and microphone/camera status.
- Refreshes and reconnects do not create duplicate requests, seats, or tiles.
- Pending requests, reserved seats, disconnected participants, and closed rooms are cleaned up automatically.
- The participant grid remains usable at 360, 375, and 390 CSS pixels.
- A real nine-client LiveKit test passes before production activation.

## 3. Existing-System Boundary

The repository's current `main` branch contains a PeerJS public broadcast under the stable peer ID `djcioko-studio-unic-id`, viewer-presence data connections, and a one-guest request/call flow. Production also exposes a same-domain LiveKit public-player API. These public paths are compatibility boundaries.

The multiparty work must not change:

- the stable PeerJS studio ID;
- handling of ordinary PeerJS media calls without multiparty metadata;
- the `viewer-presence` protocol or public viewer counter;
- the public LiveKit room, viewer leases, status states, or viewer-token contract;
- the current ON AIR/OFF AIR semantics;
- the public program's canvas and microphone tracks.

New control endpoints, room names, credentials, assets, and media sessions use a separate `party` namespace. The existing single-guest widget remains available as rollback material but is hidden when the multiparty feature flag is active. It is not used as the authoritative multiparty state store.

The deployed homepage currently differs from the available canonical local source. Deployment must begin by capturing and hashing the active production homepage and assets, then applying the smallest versioned integration. A stale local homepage must never overwrite production.

## 4. Architecture

```text
Public LIVE (unchanged)
  host program -> existing PeerJS/LiveKit public path -> public viewers

Interactive room (new and isolated)
  djcioko.ro request form -> party control API -> host moderation panel
                                              -> scoped LiveKit grants
  host + accepted guests  <-> separate LiveKit SFU room (max 9)
```

The system has four focused units:

1. **Party control service** owns room state, requests, admission, timeouts, deduplication, capacity, and administrative actions.
2. **Host party controller** opens/closes the room, renders the request queue and roster, joins the media room, and removes participants.
3. **Guest party client** collects a name, raises a hand, follows request state, obtains media only after acceptance, joins/rejoins, and cleans up on exit.
4. **Party grid renderer** attaches LiveKit tracks to stable tiles and renders names, device status, connection status, and host-only actions.

LiveKit is the WebRTC SFU for interactive media. PeerJS and the existing public LiveKit pipeline remain in place for the public broadcast. A full peer-to-peer mesh is explicitly excluded because nine participants would create up to 72 directed media relationships and would be unreliable on mobile devices.

## 5. Control-Plane State

### 5.1 Room

A party room has an opaque identifier and one of these states:

- `closed`: no requests or joins are accepted;
- `open`: the host is available and requests are accepted;
- `closing`: terminal cleanup is in progress.

The host owns seat 1 whenever the room is open. The server admits at most 8 guest reservations or active guests. If the host connection disappears unexpectedly, the room stays recoverable for 30 seconds; after that grace period the server closes it.

### 5.2 Request and participant

A request follows this state model:

```text
pending -> accepted -> joined -> left
   |          |          |       |
   +-> declined          +-> disconnected -> joined (within grace)
   +-> expired           +-> removed
              +-> expired
Any non-terminal state -> room_closed
```

Terminal states are `declined`, `expired`, `left`, `removed`, and `room_closed`.

### 5.3 Approved timing

- A pending hand-raise request expires after 90 seconds.
- An accepted reservation expires if the guest does not start joining within 45 seconds.
- A disconnected joined participant keeps the same seat for 30 seconds.
- Reconnection during the grace period reuses the same participant identity and tile.

## 6. Identity, Names, and Deduplication

The guest client creates a random browser key and stores it locally. The server never treats that key as authorization; it uses it only as one input to deduplication. The initial request returns an opaque request credential, which authorizes reading, cancelling, joining, or reconnecting only that request.

For one open room, the server permits one non-terminal request per browser identity. Repeating the click, retrying an HTTP request, refreshing the page, or reopening the data connection updates or returns the existing request. Mutating requests carry an idempotency key, and repeated keys return the original result.

Display names are:

- normalized and trimmed;
- between 1 and 32 visible characters;
- rejected when they contain control or bidirectional-override characters;
- rendered with text APIs, never inserted as HTML;
- saved only in the visitor's browser for the choose-or-enter experience.

The site offers the last three locally saved names and an “Alt nume” input. Duplicate display names are allowed; the host UI uses an additional non-public sequence marker to distinguish them.

## 7. Admission and Capacity Enforcement

Acceptance is a server transaction. It succeeds only when:

- the room is `open`;
- the request is still `pending`;
- the host session is authorized;
- fewer than 8 guest seats are reserved, joined, or inside reconnect grace.

Capacity is enforced in three places:

1. the transactional application counter;
2. a LiveKit room limit of 9;
3. webhook reconciliation that removes unknown, duplicated, expired, or over-capacity identities.

Pending requests do not consume seats. Two concurrent accept actions cannot reserve the same final seat. The host panel disables Accept at 9/9, while the server remains the authoritative guard and returns `ROOM_FULL` for stale clients.

An accepted guest receives a short, single-room, publish-and-subscribe grant through a one-time exchange. A reconnect grant is issued only for the same opaque participant identity while its 30-second grace period remains active.

## 8. Media Topology and Quality

Each participant publishes at most one camera track and one microphone track to the party room and subscribes to the other participants. The server forwards media without mixing, recording, or transcoding.

Initial constraints are:

- maximum 960×540 input;
- 15 frames per second;
- simulcast/dynacast enabled where supported;
- adaptive subscription enabled;
- low spatial layers selected for small grid tiles;
- a higher appropriate layer selected only where tile size requires it.

The host reuses cloned tracks from the existing capture pipeline where possible, so opening the party room does not request a second camera. The public program publication and the party publication remain separate; failure in one does not stop or republish the other.

All participants remain represented in the grid. On weak devices or networks, quality is reduced before participant count. Camera-off participants keep a tile with initials. No design claim is made that nine simultaneous 540p decodes will be stable on every phone; the adaptive low-layer behavior and the real nine-client gate are required.

## 9. Host Experience

The host panel adds:

- room state and occupancy (`1/9` through `9/9`);
- Open room and Close room actions;
- a request queue with display name, remaining time, Accept, and Decline;
- a responsive participant grid;
- a Remove action on every guest tile;
- microphone, camera, connection, and reconnecting indicators;
- the host's own mute, camera, and leave/close controls.

The host tile is always first and cannot be removed. Closing the room requires one confirmation when guests are present, then immediately marks the room closing, denies new grants, removes all guests, deletes the LiveKit room, and returns the UI to `closed`.

## 10. Guest Experience

The existing public page receives a versioned multiparty asset rather than another large inline script. When the room is open, the visitor sees:

1. a saved-name selector or new-name field;
2. `Ridică mâna`;
3. a live status line while waiting;
4. an explicit camera/microphone join action after acceptance;
5. the same named participant grid after joining;
6. persistent microphone, camera, and Leave controls.

Media permission is not requested when the visitor merely raises a hand. It is requested only after acceptance and a join gesture. A guest who declines permission retains a useful error message and releases the reservation rather than occupying a seat until timeout.

## 11. Responsive Grid and Accessibility

The grid uses one tile for a single participant, a two-column arrangement for two to four participants, and a three-by-three arrangement for five to nine participants when width permits. At narrow widths, tile aspect ratio and label truncation preserve readable names and controls without horizontal overflow.

Every tile contains:

- the display name;
- a microphone icon with a text alternative;
- a camera icon with a text alternative;
- connection/reconnecting status;
- initials when video is unavailable;
- a visible active-speaker outline without hiding other participants.

Primary touch controls are sticky, respect safe-area insets, and have a minimum 44-by-44-pixel hit area. Status messages use `aria-live`; dialogs manage focus; buttons have Romanian accessible names; reduced-motion preferences disable nonessential animation.

## 12. Participant Controls and Track State

Mute toggles the participant's microphone track without destroying the room connection. Camera toggles the camera publication while retaining the participant tile. Leave notifies the control service, disconnects the LiveKit room, stops local media tracks, clears media elements, and releases the seat.

Track mute/unmute, publish/unpublish, connection quality, reconnecting, and disconnect events update the shared roster and tile badges. The host can observe but does not remotely toggle another participant's devices; the host can remove that participant.

## 13. Failure Handling and Cleanup

- **Request timeout:** mark expired, notify both sides, and remove it from the host queue.
- **Join timeout:** revoke the reservation and one-time grant, then free the seat.
- **Duplicate/replayed join:** return the existing participant session or reject the spent credential; never allocate another seat.
- **Guest network loss:** show reconnecting, preserve the tile and seat for 30 seconds, then remove both.
- **Host network loss:** keep the room recoverable for 30 seconds, then close it and notify guests.
- **Permission denied/no device:** show a specific message, stop any partially created tracks, and release the reservation.
- **Host removal:** mark removed before invoking LiveKit RoomService removal so reconnect is denied.
- **Room close:** mark terminal before deleting the media room so stale webhooks or tokens cannot recreate state.
- **Page unload:** send best-effort leave/cancel and always stop local tracks locally.
- **Public LIVE failure:** remains governed by the existing public controller and must not cascade into party cleanup.

Maintenance reconciles expired requests, reservations, reconnect grace periods, LiveKit participants, and room state idempotently. Webhook event IDs are deduplicated.

## 14. Security and Privacy

- Only the authenticated host session may open/close rooms, accept/decline requests, remove participants, or obtain a host grant.
- Administrative mutations retain the existing CSRF and reauthentication rules.
- LiveKit secrets remain server-side. Grants are short-lived, room-scoped, identity-scoped, and least-privilege.
- Anonymous request and polling endpoints are rate-limited by request credential, browser identity, and IP without using the display name as an identity.
- Party media is not recorded or sent to the public room.
- Logs contain opaque identifiers and state transitions, not media or bearer credentials.
- Terminal request names are deleted within 24 hours at the latest; local saved names remain under the visitor's control.

## 15. API Families

Exact payload types are fixed in the implementation plan, but the ownership boundary is:

- `/api/live/party/status` — room availability and occupancy;
- `/api/live/party/request`, `/cancel`, `/join`, `/reconnect`, `/leave` — guest lifecycle;
- `/api/admin/live/party/open`, `/status`, `/requests/*`, `/participants/*`, `/close` — host lifecycle and moderation;
- existing `/api/live/status`, `/api/live/viewer-*`, `/api/admin/live/public/*`, and ordinary PeerJS handlers — unchanged public LIVE.

Host queue updates may use bounded long polling with a revision number. Correctness cannot depend on an always-open browser data channel.

## 16. Testing

### Automated unit and integration tests

- name validation and safe rendering;
- idempotent request creation and reconnect deduplication;
- 90-second request, 45-second join, and 30-second reconnect timers;
- simultaneous acceptance at the eighth guest boundary;
- rejection of the tenth total participant;
- webhook replay and unknown participant removal;
- host removal and terminal reconnect denial;
- room close cleanup;
- track-state-to-badge rendering;
- public PeerJS call, viewer presence, public LiveKit API, and ON AIR regression contracts.

### Browser scenarios

Separate, named scenarios cover:

1. public LIVE only;
2. one accepted guest;
3. three accepted guests;
4. participant reconnect without a duplicate tile or seat;
5. declined request;
6. nine total participants and rejection of participant ten;
7. participant leaves voluntarily;
8. host removes one participant;
9. host closes the room;
10. camera or microphone permission denied;
11. 360, 375, and 390 pixel mobile layouts.

The deterministic suite uses fakes for timers and room events. A separate real-transport test uses the actual same-domain LiveKit/TURN path and nine browser clients. Production activation is blocked until the real test confirms admission, audio/video, reconnect, cleanup, and acceptable device/server metrics.

## 17. Rollout and Rollback

1. Capture and hash the active production homepage and live assets.
2. Back up database, web release, service configuration, and current symlink targets.
3. Deploy database/control-service changes with the multiparty flag disabled.
4. Deploy versioned host and guest assets without replacing public LIVE assets.
5. Run public LIVE regression and party tests on a non-public room.
6. Run the real nine-client transport test.
7. Enable the multiparty flag for the host, then for public guests.
8. Monitor room count, joins, reconnects, LiveKit CPU/memory/bandwidth, and client errors.

Rollback disables the multiparty flag, closes party rooms, and restores the prior versioned page/assets. It does not change or roll back the public LIVE system.

## 18. Explicit Limitations and Non-Goals

- Public viewers do not see or hear the multiparty grid.
- Nine participants means one host plus at most eight guests, never nine guests.
- The room provides video/audio only; text chat, reactions, screen sharing, recording, RTMP, and moderation beyond accept/decline/remove are excluded.
- LiveKit SFU reduces upload fan-out but does not eliminate the cost of decoding several remote streams. Quality is adaptive and a real mobile test is mandatory.
- Background camera operation is not guaranteed when a mobile browser is locked or suspended.
- No full PeerJS mesh or browser-hosted media mixer is implemented as a fallback.
