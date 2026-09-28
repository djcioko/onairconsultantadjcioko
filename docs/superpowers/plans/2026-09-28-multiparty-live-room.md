# DJCIOKOSTUDIO Multiparty Live Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a moderated LiveKit SFU room for one host and up to eight named guests while leaving the existing public PeerJS and LiveKit LIVE paths unchanged.

**Architecture:** A new Flask/SQLite party control plane owns requests, idempotency, seats, timeouts, scoped LiveKit grants, and moderation. Focused host and guest JavaScript controllers join a separate `party-<32 hex>` LiveKit room and share a stable responsive grid; the legacy public broadcast remains an immutable compatibility surface.

**Tech Stack:** Vanilla JavaScript ES modules, PeerJS 1.5.2 compatibility layer, LiveKit Client 2.22.3, Vite 8.3.0, Vitest 5.0.1, Playwright 1.63.0, Python/Flask, SQLite, pytest, LiveKit RoomService.

**Spec:** `docs/superpowers/specs/2026-09-28-multiparty-live-room-design.md`

## Global Constraints

- Capacity is exactly 9 total participants: 1 host plus at most 8 accepted guests.
- Pending requests expire after 90 seconds; accepted reservations after 45 seconds; disconnected seats after 30 seconds.
- The stable PeerJS ID `djcioko-studio-unic-id`, ordinary media-call branch, `viewer-presence` protocol, viewer counter, public LiveKit room/API, and ON AIR/OFF AIR behavior must not change.
- Base compatibility hashes are `stream.js=a826ee44edbde92b38bdede9b627f6d2ac23450cf16a3d6c36311ac293a07cca` and `site-viewer-presence.js=ea1fd7f3c73b5cad353efc5323382b106888e4387d3242f4006c1c7dcafef3d9`; tests fail on any byte change.
- Public viewers never subscribe to party tracks; party media never enters the public program.
- Party room names match `party-[a-f0-9]{32}` and LiveKit enforces `max_participants=9`.
- Each client publishes at most one camera and one microphone track at maximum 960×540 and 15 fps, using simulcast/dynacast and adaptive subscriptions where supported.
- Display names contain 1–32 visible characters after normalization and reject control and bidirectional-override characters.
- `LIVE_PARTY_ENABLED` is the host/control-plane kill switch and `LIVE_PARTY_GUEST_ENABLED` is the separately staged public exposure flag; both default to false and the guest flag is invalid unless the host flag is enabled.
- The client-generated browser key is a 128-bit-or-stronger random base64url value stored as `djcioko.party.browser.v1`; it is sent as `X-Party-Browser` for deduplication only. Authorization always requires the opaque `X-Party-Token` credential plus its bound HttpOnly browser cookie.
- Use the latest public repository main (`e290238`) plus design commit `4c8c10d` as the frontend base. Do not merge the divergent LiveKit branch wholesale or replace current `stream.js` with its older copy.
- Work against an isolated sibling clone of the server repository, never the dirty source checkout. Verify its base against the deployed source before promotion.
- Production homepage integration is marker- and hash-guarded. Never overwrite the active homepage from a stale local copy.
- Administrative party APIs remain same-origin and cookie/CSRF protected. The repository builds the host UI served at `https://djcioko.ro/admin/live-studio/`; GitHub Pages may link or redirect there but must not add credentialed cross-origin API calls.

## Review Focus

- Party tracks must never appear in the public PeerJS/LiveKit program, including during host join, reconnect, removal, and close; Tasks 8 and 10 add isolation tests.
- Concurrent accepts/tokens must not reserve a ninth guest or duplicate a seat; Tasks 2 and 4 add transactional and HTTP race tests.
- Stale join/left/reconnect webhooks must not resurrect a removed guest or evict a replacement generation; Task 5 adds SID/generation/timestamp tests.
- Declined, expired, removed, and room-closed guests must not use an old JWT or obtain a reconnect grant; Tasks 4 and 5 exercise every terminal state.
- Mobile permission denial, autoplay blocking, reconnect controls, and 360/375/390 px grids must remain usable; Tasks 7 and 10 add browser coverage.

---

## Repository and File Map

Use these roots during execution:

- `FRONTEND_ROOT`: this repository, `onairconsultantadjcioko`.
- `SERVER_ROOT`: sibling `../djcioko-livekit-server`, cloned locally from `C:/Users/UTENTE/Documents/Codex/2026-09-23/file-c-users-utente-appdata-local/work/djcioko-livekit-server` at commit `9196ede2b72db8d3df763a82949c19fccb52b1eb` after recording its dirty untracked deployment-note path and comparing deployed source hashes.
- `REFERENCE_STUDIO_ROOT`: read-only worktree `C:/Users/UTENTE/Documents/Codex/2026-09-23/file-c-users-utente-appdata-local/work/phone-studio-inspect/.worktrees/livekit-implementation` at commit `d3fe8a8620916568886e2a463bc5b552d7fc0ac6`; copy only the files named in Task 1 and never merge or modify this worktree.

Frontend responsibilities:

- `stream.js`: immutable existing public PeerJS behavior and legacy one-guest rollback path.
- `index.html`: existing public-compatible studio plus, at most, a link to the secure same-origin multiparty studio.
- `studio/src/program-stream.js`: existing tested program media pipeline plus isolated party-owned 540p15 derived tracks.
- `studio/src/party-host.js`: room open/state polling/moderation, host join/rejoin, controls, and close.
- `studio/src/main.js`: mounts the party panel inside the protected studio without changing public-room control.
- `site/src/party-api.js`: typed public/admin HTTP contract and request credential handling.
- `site/src/party-names.js`: display-name validation and last-three local names.
- `site/src/party-grid.js`: stable identity tiles, LiveKit track attachment, and device/connection badges.
- `site/src/party-guest.js`: hand raise, polling, consent, join/rejoin, controls, leave, and cleanup.
- `site/styles/party-room.css`: shared responsive grid and accessible controls.
- `scripts/assemble-party-release.mjs`: deterministic versioned host/guest assets and manifest.

Server responsibilities:

- `backend/app/db.py`: additive live schema v3.
- `backend/app/config.py`: disabled-by-default party feature gates and validation.
- `backend/app/party_models.py`: transactional party state and deadline enforcement.
- `backend/app/party_v2.py`: public/admin party HTTP endpoints and webhook/maintenance adapters.
- `backend/app/livekit_gateway.py`: party room capacity, roles, grants, and participant validation.
- `backend/app/live_v2.py`: route already-deduplicated party webhooks and call party maintenance without changing public/private behavior.
- `backend/app/__init__.py`: register the party blueprint under the existing LiveKit enablement gate.
- `tools/patch_party_home.py`: hash- and marker-guarded production homepage integration.

## Task 1: Pin the Frontend Toolchain and Public LIVE Contract

**Files:**
- Create: `package.json`
- Create: `vitest.config.js`
- Create: `vite.party.config.js`
- Create: `vite.studio.config.js`
- Create: `studio/index.html`
- Create: `studio/src/main.js`
- Create: `studio/src/media-lifecycle.js`
- Create: `studio/src/program-stream.js`
- Create: `studio/src/room-controller.js`
- Create: `studio/src/studio.css`
- Create: `site/src/live-api.js`
- Create: `site/src/remote-playback.js`
- Create: `scripts/copy-mediapipe-assets.mjs`
- Create: `tests/tooling-contract.test.js`
- Create: `tests/contracts/secure-studio-baseline.test.js`
- Create: `tests/public-live-regression.test.js`
- Create: `tests/media/mediapipe-assets.test.js`
- Modify: `package-lock.json` (generated from the pinned manifest)
- Test: `tests/stream.test.js`
- Test: `tests/site-viewer-presence.test.js`

**Interfaces:**
- Consumes: current root `index.html`, `stream.js`, and `site-viewer-presence.js`.
- Produces: scripts `test:legacy`, `test`, `assets:mediapipe`, `build:studio`, `build:party`, `build:release`, and `test:browser`; pinned LiveKit/MediaPipe/Vite/Vitest/jsdom/Playwright dependencies; a selectively imported same-origin studio baseline; executable compatibility assertions for every public LIVE boundary.

- [ ] **Step 1: Write the failing tooling contract**

Add `tests/tooling-contract.test.js` using `node:test`. It must assert exact versions `livekit-client=2.22.3`, `@mediapipe/selfie_segmentation=0.1.1675465747`, `vite=8.3.0`, `vitest=5.0.1`, `jsdom=30.1.1`, and `@playwright/test=1.63.0`, the seven script names above, and the focused protected-studio source paths. Before copying, assert `git -C [REFERENCE_STUDIO_ROOT] rev-parse HEAD` equals `d3fe8a8620916568886e2a463bc5b552d7fc0ac6`; stop rather than substituting an unreviewed source.

- [ ] **Step 2: Run the tooling test and verify RED**

Run: `node --test tests/tooling-contract.test.js`
Expected: FAIL because `package.json` does not exist.

- [ ] **Step 3: Add the minimal pinned manifest and configs**

Add `package.json`, `vitest.config.js`, `vite.studio.config.js`, and a guest-only `vite.party.config.js` that reserves stable entry `party-guest-v1` without changing root HTML. Selectively copy the reviewed protected-studio files listed in this task from the pinned reference commit, including its same-origin API, remote-playback, and pinned MediaPipe asset copier; do not copy its deleted root page or its older `studio/stream.js`. Generate `package-lock.json` with `npm install --package-lock-only`.

- [ ] **Step 4: Run the tooling test and install dependencies**

Run `node --test tests/tooling-contract.test.js`, verify PASS, then run `npm ci` and `npx playwright install chromium`.
Expected: the contract passes, the clean install succeeds, and the pinned browser is installed.

- [ ] **Step 5: Add the public LIVE characterization test**

`tests/public-live-regression.test.js` must first assert both exact SHA-256 values from Global Constraints, then assert the stable Peer ID, PeerJS 1.5.2 load, `viewer-presence`, ordinary `call.answer(broadcastStream)`, canvas video plus microphone broadcast, and the unmodified public viewer-count message shape. `tests/contracts/secure-studio-baseline.test.js` must characterize the imported public LiveKit controller and program-track ownership before party changes. `tests/media/mediapipe-assets.test.js` must prove the local asset copier emits the pinned runtime files beneath the protected-studio base with no runtime CDN dependency.

- [ ] **Step 6: Run all legacy and contract tests**

Run `npm run test:legacy`, then `node --test tests/tooling-contract.test.js tests/public-live-regression.test.js`, then `npx vitest run tests/contracts/secure-studio-baseline.test.js tests/media/mediapipe-assets.test.js`.
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json vitest.config.js vite.party.config.js vite.studio.config.js studio site/src/live-api.js site/src/remote-playback.js scripts/copy-mediapipe-assets.mjs tests
git commit -m "test: pin party build and public live contract"
```

## Task 2: Add the Transactional Party Schema and Store

**Files:**
- Modify: `[SERVER_ROOT]/backend/app/db.py`
- Create: `[SERVER_ROOT]/backend/app/party_models.py`
- Create: `[SERVER_ROOT]/backend/tests/test_party_models.py`
- Test: `[SERVER_ROOT]/backend/tests/test_live_models.py`

**Interfaces:**
- Produces immutable records `PartySession`, `PartyRequest`, `PartyMember`, `PartyReceipt`, and `PartyExpiryBatch`.
- Session states are exactly `open|closing|closed`; request states are `pending|accepted|joined|declined|expired|left|removed|room_closed`; member states are `reserved|active|disconnected|left|removed|expired|room_closed`.
- Produces these exact store methods:
  - `open_session(*, session_id: str, room_name: str, room_sid: str, owner_user_id: int, owner_admin_session_id: int, owner_device_id: str | None, host_identity: str, now: float) -> PartySession`
  - `create_or_get_request(*, party_session_id: str, browser_key_hash: str, browser_cookie_hash: str, request_token_hash: str, display_name: str, now: float) -> tuple[PartyRequest, bool]`
  - `accept_request(*, party_session_id: str, request_id: str, expected_revision: int, now: float) -> tuple[PartyRequest, PartyMember]`
  - `decline_request(*, party_session_id: str, request_id: str, expected_revision: int, now: float) -> PartyRequest`
  - `cancel_request(*, request_id: str, browser_key_hash: str, browser_cookie_hash: str, request_token_hash: str, now: float) -> PartyRequest`
  - `exchange_join(*, request_id: str, browser_key_hash: str, browser_cookie_hash: str, request_token_hash: str, now: float) -> PartyMember`
  - `apply_join(*, room_name: str, room_sid: str, identity: str, role: str, generation: int, participant_sid: str, event_at: float) -> PartySession | PartyMember`
  - `apply_left(*, room_name: str, room_sid: str, identity: str, role: str, generation: int, participant_sid: str, event_at: float) -> PartySession | PartyMember`
  - `reserve_guest_reconnect(*, member_id: str, browser_key_hash: str, browser_cookie_hash: str, request_token_hash: str, now: float) -> PartyMember`
  - `reserve_host_reconnect(*, party_session_id: str, owner_user_id: int, owner_admin_session_id: int, owner_device_id: str | None, now: float) -> PartySession`
  - `leave_member(*, member_id: str, browser_key_hash: str, browser_cookie_hash: str, request_token_hash: str, now: float) -> PartyMember`
  - `remove_member(*, party_session_id: str, member_id: str, expected_revision: int, now: float) -> PartyMember`
  - `close_session(*, party_session_id: str, expected_revision: int, now: float) -> PartySession`
  - `expire_due(*, now: float) -> PartyExpiryBatch`
  - `run_idempotent(*, scope: str, action: str, key_hash: str, payload_hash: str, now: float, mutate: Callable[[], tuple[int, dict]]) -> tuple[int, dict, bool]`
- `run_idempotent` persists a token-free receipt in the same transaction as the `_locked` mutation, returns the original status/body on replay, and raises `TransitionError("IDEMPOTENCY_CONFLICT")` when the same key has a different payload hash.
- Every mutating method uses `BEGIN IMMEDIATE` or an explicit `_locked` helper and checks its deadline inside the transaction.

- [ ] **Step 1: Prepare the isolated server clone**

Assert the source HEAD is exactly `9196ede2b72db8d3df763a82949c19fccb52b1eb`, record its status, clone it to `[SERVER_ROOT]`, create branch `feature/multiparty-live-room`, and confirm the clone is clean. Do not copy the source checkout's untracked deployment notes. Create `.venv` and install exactly `[SERVER_ROOT]/backend/requirements.lock`:

```powershell
py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock
```

- [ ] **Step 2: Write failing migration and constraint tests**

Add tests that assert schema version 3 creates `live_party_sessions`, `live_party_requests`, `live_party_members`, and `live_party_receipts`; validates all state enums; enforces unique room/request/member/receipt scopes; and leaves existing v2 tables unchanged.

- [ ] **Step 3: Run the schema tests and verify RED**

Run from `[SERVER_ROOT]`:

```powershell
$env:PYTHONPATH = (Resolve-Path .\backend).Path
& .\.venv\Scripts\python.exe -m pytest backend/tests/test_party_models.py -q
```

Expected: FAIL because schema v3 and `PartyStore` do not exist.

- [ ] **Step 4: Implement schema v3 and record types**

Add an idempotent version-3 migration using the existing savepoint/serialization pattern. Store owner session/device binding, opaque room/SID/generation, a per-session monotonic `display_sequence` assigned when a request is first created, separate hashes for the client browser key, HttpOnly browser cookie, and request credential, token-free idempotency receipts, participant identity/SID/generation, revision, 90/45/30 deadlines, and purge timestamps.

- [ ] **Step 5: Write failing capacity, idempotency, and deadline tests**

Tests must prove: one browser key gets one non-terminal request in one room; duplicate display names receive different stable sequences; the opaque credential plus both browser bindings are required for private state; replay with the same idempotency key returns the same token-free receipt; the same key with a different payload raises `TransitionError("IDEMPOTENCY_CONFLICT")`; eight `reserved|active|disconnected` guests fill the room; the ninth guest accept fails; two concurrent join exchanges produce one generation/seat and one `JOIN_ALREADY_EXCHANGED`; voluntary leave or permission denial frees the reservation immediately; host disconnect/rejoin reuses its identity only inside 30 seconds; expiration frees the correct seat; restart preserves deadlines.

- [ ] **Step 6: Run the store tests and verify RED**

Run the Task 2 pytest command.
Expected: the new behavioral tests FAIL on missing store methods.

- [ ] **Step 7: Implement the minimal `PartyStore` behavior**

Use stable participant identities and monotonically increasing generations. A join exchange atomically marks the accepted reservation consumed before a grant is signed; reconnect increments only the generation, not the seat or identity. Admission counts the host plus guest rows in `reserved`, `active`, or unexpired `disconnected`; pending requests never count.

- [ ] **Step 8: Run party and legacy model tests**

Run:

```powershell
& .\.venv\Scripts\python.exe -m pytest backend/tests/test_party_models.py backend/tests/test_live_models.py -q
```

Expected: all tests PASS.

- [ ] **Step 9: Commit in the server clone**

```powershell
git add backend/app/db.py backend/app/party_models.py backend/tests/test_party_models.py
git commit -m "feat: add transactional party room state"
```

## Task 3: Add Party-Scoped LiveKit Grants

**Files:**
- Modify: `[SERVER_ROOT]/backend/app/livekit_gateway.py`
- Modify: `[SERVER_ROOT]/backend/tests/test_livekit_gateway.py`

**Interfaces:**
- Produces `room_capacity("party-<32 hex>") -> 9`.
- Produces `LiveKitGateway.issue_party_host(identity, room, generation, display_name="DJ Cioko", ttl_seconds=30) -> str`.
- Produces `LiveKitGateway.issue_party_guest(identity, room, generation, display_name, display_sequence, ttl_seconds=45) -> str`.
- Extends `validate_participant(participant, *, role, generation, identity)` for roles `party-host` and `party-guest` without altering public/private roles.

- [ ] **Step 1: Write failing party grant tests**

Add parameterized tests asserting room capacity 9, rejection/recreation of a same-name room whose server-reported capacity is not 9, exact room/identity/role/generation claims, signed `display_name` and non-public `display_sequence` participant attributes available only inside the room, no permission to update identity/metadata, subscribe permission plus publish permission restricted to camera/microphone sources, short grant TTLs, rejection of malformed room names, rejection of escalated grants, and unchanged capacities 21 for `djcioko-public` and 2 for `private-*`.

- [ ] **Step 2: Run the focused gateway tests and verify RED**

Run:

```powershell
& .\.venv\Scripts\python.exe -m pytest backend/tests/test_livekit_gateway.py -q
```

Expected: FAIL because party rooms and grant helpers are unsupported.

- [ ] **Step 3: Implement party room validation and grant helpers**

Keep `TokenGrant` immutable and use the existing signer/config. Do not change the global LiveKit capacity of 21 because the public room still requires it; pass 9 when creating each party room.

- [ ] **Step 4: Run the gateway suite**

Run the Task 3 pytest command.
Expected: all tests PASS.

- [ ] **Step 5: Commit in the server clone**

```powershell
git add backend/app/livekit_gateway.py backend/tests/test_livekit_gateway.py
git commit -m "feat: issue scoped nine-seat party grants"
```

## Task 4: Implement Public Requests and Host Moderation APIs

**Files:**
- Create: `[SERVER_ROOT]/backend/app/party_v2.py`
- Modify: `[SERVER_ROOT]/backend/app/__init__.py`
- Modify: `[SERVER_ROOT]/backend/app/config.py`
- Create: `[SERVER_ROOT]/backend/tests/test_party_v2.py`
- Modify: `[SERVER_ROOT]/backend/tests/test_live_factory.py`
- Modify: `[SERVER_ROOT]/backend/tests/test_livekit_gateway.py`

**Interfaces:**
- Public: `GET /api/live/party/status`; `POST|GET /api/live/party/request`; `POST /api/live/party/cancel`; `POST /api/live/party/join`; `POST /api/live/party/reconnect`; `POST /api/live/party/leave`.
- Admin: `POST /api/admin/live/party/open`; `POST /host-rejoin`; `GET /status`; `POST /requests/accept`; `POST /requests/decline`; `POST /participants/remove`; `POST /close`.
- `GET /api/live/party/status` returns only `{enabled, open, capacity: 9, occupancy}`. `POST /request` returns `{requestId, credential, state, expiresAt}`; authenticated `GET /request` returns `{requestId, state, displayName, expiresAt, participant}` without room/grant data.
- A successful `POST /join` or `/reconnect` returns `{url, room, token, identity, generation, expiresAt}`. The first join consumes the accepted exchange; an exact idempotency replay returns the same participant generation, while a new exchange key receives `JOIN_ALREADY_EXCHANGED` and must use `/reconnect` after an observed disconnect.
- `POST /api/admin/live/party/open` returns `{sessionId, revision, state, capacity, occupancy, url, token, identity, generation}`. `GET /api/admin/live/party/status?sessionId=&sinceRevision=&waitMs=` supports bounded long polling with `0 <= waitMs <= 25000` and returns `{sessionId, revision, state, capacity, occupancy, requests, participants}` keyed by opaque IDs.
- Admin request entries are `{requestId, displayName, displaySequence, state, createdAt, expiresAt}`; participant entries are `{memberId, identity, role, displayName, displaySequence, state}`. Host and guest controllers enrich that stable identity/name roster with microphone, camera, speaking, and connection quality from their party-room LiveKit participant/publication events; no public viewer receives this metadata.
- Public requests send `X-Party-Browser`; credential-protected requests also send `X-Party-Token`; all mutations require `Idempotency-Key`. Admin mutations additionally reuse global `X-DJCioko-CSRF`, owner session, Origin, and trusted-device/re-authentication binding.
- `LIVE_PARTY_ENABLED` gates host/control APIs and closes active party sessions when disabled; `LIVE_PARTY_GUEST_ENABLED` gates anonymous status/request/join endpoints. Neither flag changes existing public LIVE endpoints.
- HTTP mappings are exact: disabled mutations and LiveKit failures return 503; `INVALID_NAME` returns 400; `AUTH_REQUIRED` returns 401; `REQUEST_BINDING`, `FORBIDDEN`, `CSRF`, and `ORIGIN` return 403; `PARTY_CLOSED`, `REQUEST_DECLINED`, `ROOM_FULL`, `JOIN_ALREADY_EXCHANGED`, `REVISION_CONFLICT`, and `IDEMPOTENCY_CONFLICT` return 409; `REQUEST_EXPIRED`, `JOIN_EXPIRED`, `RECONNECT_EXPIRED`, and `REMOVED` return 410; `RATE_LIMIT` returns 429. Disabled/status GETs remain 200 with `enabled:false`.

- [ ] **Step 1: Write failing public request tests**

Tests assert name validation, HTTP 201 request creation, replay receipt, 409 changed-payload replay, 90-second expiry checked at request/poll/join time, request-token plus client-key plus cookie binding, per-IP/per-browser-key/per-credential rate limiting, cancel, one-time join exchange, no bearer values in logs, and every combination of the disabled feature flags.

- [ ] **Step 2: Write failing host lifecycle and race tests**

Tests assert owner/Origin/JSON/CSRF/recent-device rules, bounded long-poll limits, room creation at 9, orphan-room cleanup after a losing concurrent open, host counted as occupancy 1, revision conflicts, exact replay/conflict receipts for open/accept/decline/join/reconnect/leave/remove/close, eight concurrent successful guest accepts and one `ROOM_FULL`, two concurrent join exchanges yielding one grant generation, remove-before-LiveKit-eviction, close-before-room-deletion, and denial of join/reconnect in every terminal state.

- [ ] **Step 3: Run the API tests and verify RED**

Run:

```powershell
& .\.venv\Scripts\python.exe -m pytest backend/tests/test_party_v2.py backend/tests/test_live_factory.py -q
```

Expected: FAIL because the blueprint and endpoints do not exist.

- [ ] **Step 4: Implement the party blueprint and registration**

Reuse or extract the existing `_gateway`, `_owner`, `_browser`, `_browser_hash`, `_with_browser_cookie`, `_rate_limit`, and `_payload` behavior from `live_v2.py`; do not duplicate CSRF/session stores. Add both party flags to `load_config()` and `testing_defaults()` as false-by-default booleans, reject `LIVE_PARTY_GUEST_ENABLED=1` unless `LIVE_PARTY_ENABLED=1`, and register the blueprint only on the existing LiveKit v2 factory branch. All party mutations fail closed unless both `LIVEKIT_ENABLED` and their applicable party flag are true.

- [ ] **Step 5: Implement exact response and error contracts**

Use errors `PARTY_DISABLED`, `PARTY_CLOSED`, `INVALID_NAME`, `REQUEST_BINDING`, `REQUEST_EXPIRED`, `REQUEST_DECLINED`, `ROOM_FULL`, `JOIN_EXPIRED`, `JOIN_ALREADY_EXCHANGED`, `RECONNECT_EXPIRED`, `REMOVED`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, and `RATE_LIMIT`. Never return room names or grants before acceptance.

- [ ] **Step 6: Run party and public API regressions**

Run:

```powershell
& .\.venv\Scripts\python.exe -m pytest backend/tests/test_party_v2.py backend/tests/test_live_v2.py backend/tests/test_live_factory.py backend/tests/test_live_access.py -q
```

Expected: all tests PASS.

- [ ] **Step 7: Commit in the server clone**

```powershell
git add backend/app/party_v2.py backend/app/__init__.py backend/app/config.py backend/tests/test_party_v2.py backend/tests/test_live_factory.py backend/tests/test_livekit_gateway.py
git commit -m "feat: add moderated party room APIs"
```

## Task 5: Reconcile Party Webhooks and Deadlines

**Files:**
- Modify: `[SERVER_ROOT]/backend/app/party_models.py`
- Modify: `[SERVER_ROOT]/backend/app/party_v2.py`
- Modify: `[SERVER_ROOT]/backend/app/live_v2.py`
- Modify: `[SERVER_ROOT]/backend/tests/test_party_v2.py`
- Test: `[SERVER_ROOT]/backend/tests/test_live_v2.py`

**Interfaces:**
- Produces `handle_party_webhook(*, event, received_at: float) -> bool`, returning `False` for non-party rooms and `True` after party handling.
- Produces `run_party_maintenance(*, now: float) -> PartyExpiryBatch`.
- Consumes the existing global webhook-event dedupe and reconciliation-action queue.

- [ ] **Step 1: Write failing webhook ordering tests**

Cover duplicate event IDs, unknown identities, wrong role, old room SID, old participant SID, stale generation, out-of-order `created_at`, reconnect generation replacement, a removed/expired/room-closed identity joining with an old still-unexpired JWT, an unexpected tenth participant, extra publications or non-camera/non-microphone sources, and delayed cleanup for a prior room. Every invalid participant is queued for removal without changing the authoritative seat count.

- [ ] **Step 2: Write failing maintenance tests**

Prove the 8-second timer may clean late but every endpoint rejects at the exact 90/45/30 deadline; a missing guest loses its seat after 30 seconds; a missing host closes the room after 30 seconds and each guest poll reports `room_closed`; disabling `LIVE_PARTY_ENABLED` closes all open party rooms without touching public LIVE; maintenance expires rows idempotently, removes LiveKit participants, deletes only the matching room SID, purges bearer-free receipts, and erases terminal names within 24 hours. Inject RoomService failures to prove remove/close state commits before network cleanup, remains terminal while actions retry with backoff, and a later retry cannot affect a replacement room SID or generation.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
& .\.venv\Scripts\python.exe -m pytest backend/tests/test_party_v2.py -q
```

Expected: new webhook and maintenance tests FAIL.

- [ ] **Step 4: Route party events after existing signature/dedupe checks**

Call `handle_party_webhook` from the existing `/api/livekit/webhook` path only after official signature verification and event-ID insertion. Queue idempotent participant removal for unknown, stale, terminal, duplicated, or over-capacity identities. Extend `maintenance_tick()` without changing public/private branches, and prove a non-party event is processed exactly once by the pre-existing code.

- [ ] **Step 5: Run webhook, maintenance, and public regressions**

Run:

```powershell
& .\.venv\Scripts\python.exe -m pytest backend/tests/test_party_v2.py backend/tests/test_live_v2.py backend/tests/test_live_models.py -q
```

Expected: all tests PASS.

- [ ] **Step 6: Commit in the server clone**

```powershell
git add backend/app/party_models.py backend/app/party_v2.py backend/app/live_v2.py backend/tests/test_party_v2.py
git commit -m "feat: reconcile party room lifecycle"
```

## Task 6: Build Shared Names, API, and Grid Modules

**Files:**
- Create: `site/src/party-names.js`
- Create: `site/src/party-api.js`
- Create: `site/src/party-grid.js`
- Create: `site/styles/party-room.css`
- Create: `tests/party-names.test.js`
- Create: `tests/party-api.test.js`
- Create: `tests/party-grid.test.js`

**Interfaces:**
- Produces `normalizePartyName(value: string) -> string`, `loadPartyNames(storage) -> string[]`, `rememberPartyName(storage, value) -> string[]`, and `loadOrCreatePartyBrowserKey(storage, cryptoImpl) -> string` using storage key `djcioko.party.browser.v1`.
- Produces `createPartyApi({fetchImpl, csrf, browserKey, requestToken})` with exact methods `getStatus()`, `createRequest({name, idempotencyKey})`, `getRequest()`, `cancel({idempotencyKey})`, `join({idempotencyKey})`, `reconnect({idempotencyKey})`, `leave({idempotencyKey, keepalive})`, `adminOpen({idempotencyKey})`, `adminRejoin({sessionId, idempotencyKey})`, `adminStatus({sessionId, sinceRevision, waitMs})`, `adminAccept({sessionId, requestId, revision, idempotencyKey})`, `adminDecline({sessionId, requestId, revision, idempotencyKey})`, `adminRemove({sessionId, memberId, revision, idempotencyKey})`, and `adminClose({sessionId, revision, idempotencyKey})`.
- Produces `createPartyGrid({root, localIdentity, onRemove})` with `applyRoster(snapshot)`, `attachTrack(identity, track, publication)`, `detachTrack(identity, kind)`, `setTrackState(identity, kind, state)`, `setConnectionState(identity, state)`, `setConnectionQuality(identity, quality)`, `setSpeaking(identity, active)`, `remove(identity)`, and `clear()`.

- [ ] **Step 1: Write failing name and storage tests**

Assert NFC trim, 1–32 visible characters, control/bidi rejection, safe plain-text output, deduplicated most-recent-first last-three names, recovery from malformed local storage, and stable generation/reuse of a base64url browser key with at least 128 bits of randomness.

- [ ] **Step 2: Run name tests and verify RED**

Run: `npx vitest run tests/party-names.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `party-names.js` and verify GREEN**

Run the Task 6 name command.
Expected: PASS.

- [ ] **Step 4: Write failing API contract tests**

Assert method/path/body/header mappings, `X-Party-Browser`, `X-Party-Token`, `Idempotency-Key`, `X-DJCioko-CSRF`, no credential in URLs/referrers/loggable errors, eight-second abort timeout, bounded `waitMs`, keepalive leave/cancel, JSON validation, and Romanian mappings for every Task 4 error code.

- [ ] **Step 5: Implement `party-api.js` and verify GREEN**

Run: `npx vitest run tests/party-api.test.js`
Expected: PASS.

- [ ] **Step 6: Write failing stable-grid tests**

Using jsdom and fake LiveKit participants/tracks, assert `applyRoster` accepts `{identity, role, displayName, displaySequence, state, microphone, camera, connectionQuality}`, one tile exists per opaque identity, signed LiveKit attributes populate the guest roster, host is first, reconnect reuses the tile, duplicate names receive distinct non-public sequence labels, name/status updates do not recreate media elements, muted/unmuted and publish/unpublish events update microphone/camera badges, camera-off initials, connection-quality/reconnecting badges, active-speaker outline, host-only Remove buttons, and no use of `innerHTML` for names.

- [ ] **Step 7: Implement the grid and CSS, then run all shared tests**

Implement the 1-tile, 2-column-for-2–4, and up-to-3-column-for-5–9 grid; adapt video quality through LiveKit's element-size-driven adaptive stream; retain every participant tile; enforce 44×44 px controls, safe-area insets, name truncation, and reduced-motion behavior. Then run: `npx vitest run tests/party-names.test.js tests/party-api.test.js tests/party-grid.test.js`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```powershell
git add site/src/party-*.js site/styles/party-room.css tests/party-*.test.js
git commit -m "feat: add shared party client primitives"
```

## Task 7: Implement the Guest Hand-Raise and Room Lifecycle

**Files:**
- Create: `site/src/party-guest.js`
- Create: `site/src/party-guest-entry.js`
- Create: `tests/party-guest.test.js`

**Interfaces:**
- Produces `createPartyGuest({api, grid, roomFactory, mediaDevices, localStorage, sessionStorage, timers, onState})`.
- Controller methods: `mount(root)`, `raiseHand(name)`, `poll()`, `join()`, `reconnect()`, `setMicrophoneEnabled(enabled)`, `setCameraEnabled(enabled)`, `leave({notify=true})`, and `destroy()`.
- Controller state: `idle|pending|accepted|joining|joined|reconnecting|declined|expired|removed|room_closed|error`.

- [ ] **Step 1: Write failing request-state tests**

Cover choose-or-enter name, one active request, 90-second expiry, decline, room full, repeated poll responses, restoration of the opaque credential from session storage after refresh, reuse of the local browser key, cancel, closed-room UI, feature-disabled fallback, and terminal cleanup. The entry hides the legacy one-guest widget only when `status.enabled === true`, and shows `Ridică mâna` only while `status.open === true`.

- [ ] **Step 2: Run guest tests and verify RED**

Run: `npx vitest run tests/party-guest.test.js`
Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement request/poll state without media**

Use one two-second poll timer keyed by an epoch. Stale promise/timer completions must not change a newer state.

- [ ] **Step 4: Write failing join/reconnect/control tests**

Assert no media permission before accepted plus explicit join, 960×540/15 fps constraints, exactly one `party-camera` and one `party-microphone` publication, one-time `api.join()` exchange, 45-second join error, 30-second `api.reconnect()` identity reuse, signed participant attributes supplying every remote display name/sequence, LiveKit publish/unpublish/mute/unmute/quality/reconnecting event mapping into the grid, track mute/camera state, permission denial immediately calling leave to release the seat, autoplay fallback, explicit leave, `pagehide` sending cancel while pending or leave while reserved/joined, and unconditional local track stop.

- [ ] **Step 5: Implement media lifecycle and entry UI**

Create the modal/grid/controls with `aria-live`, Romanian accessible labels, a trapped modal focus cycle plus focus return, safe-area controls, and the shared grid. Configure LiveKit `adaptiveStream` and `dynacast`, publish simulcast tracks, and let video-element dimensions select lower spatial layers for small tiles.

- [ ] **Step 6: Run guest and shared tests**

Run: `npx vitest run tests/party-names.test.js tests/party-api.test.js tests/party-grid.test.js tests/party-guest.test.js`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add site/src/party-guest*.js tests/party-guest.test.js
git commit -m "feat: add named guest party workflow"
```

## Task 8: Implement Host Moderation in the Protected Studio

**Files:**
- Create: `studio/src/party-host.js`
- Create: `studio/src/party-media.js`
- Create: `tests/party-host.test.js`
- Create: `tests/party-media.test.js`
- Modify: `studio/src/program-stream.js`
- Modify: `studio/src/main.js`
- Modify: `studio/index.html`
- Modify: `studio/src/studio.css`
- Test: `tests/public-live-regression.test.js`
- Test: `tests/contracts/secure-studio-baseline.test.js`

**Interfaces:**
- Produces `createPartyMediaBridge({programStream})` with `createOwnedTracks()`, `setAudioEnabled(tracks, enabled)`, `setVideoEnabled(tracks, enabled)`, and `stopOwnedTracks(tracks)`; every party track is a clone owned by the party controller.
- Extends `ProgramStream` with `createPartyTracks({width=960, height=540, fps=15}={}) -> {videoTrack, audioTrack}` and `releasePartyTracks(tracks) -> void` without transferring ownership of public-room tracks. The video is a party-owned 960×540 canvas derivation clocked at 15 fps, not a raw 720p24 clone.
- Produces `createPartyHost({api, grid, roomFactory, mediaBridge, timers, onState})` with `open()`, `pollStatus()`, `accept(requestId)`, `decline(requestId)`, `remove(memberId)`, `setMicrophoneEnabled(enabled)`, `setCameraEnabled(enabled)`, `reconnect()`, `close({confirmed})`, and `destroy()`.

- [ ] **Step 1: Write failing media-ownership tests**

Assert party video is a separately owned 960×540 canvas track captured at 15 fps from the protected studio program and party audio is a microphone clone; both publish exactly once as `party-camera` and `party-microphone` with simulcast encodings no larger than 960×540. Party mute/camera-off affects only those tracks; stopping them cancels the 15-fps draw loop and removes them from `ProgramStream` ownership but never mutes or stops the source/public-room tracks; missing microphone yields a visible host error; and repeated open/close releases every derived track.

- [ ] **Step 2: Run media tests and verify RED**

Run: `npx vitest run tests/party-media.test.js`
Expected: FAIL because the bridge does not exist.

- [ ] **Step 3: Implement the media bridge**

Add only the party-owned downscale track and microphone-clone behavior to `ProgramStream`; do not change `StudioRoomController` public room names, grants, ON AIR states, frame rate, resolution, or ownership of its existing tracks. Root `stream.js` remains byte-for-byte unchanged.

- [ ] **Step 4: Write failing host controller tests**

Cover occupancy starting at 1/9, room open, revision-based bounded long polling, named queue with countdown, accept/decline, 9/9 disabling plus server error, duplicate action receipts, stable roster tiles, LiveKit track/quality/reconnect event mapping, remove, host 30-second reconnect, local controls, close confirmation with guests, close cleanup, disabling the legacy private panel only while the host party flag is active, and public LIVE isolation.

- [ ] **Step 5: Implement host controller and mount**

Mount a separate panel/grid from protected `studio/src/main.js`. Join only the party room and publish only cloned party tracks. Preserve the legacy private-call panel as rollback material and hide it only while the authenticated party host API reports enabled.

- [ ] **Step 6: Run host, bridge, and public regressions**

Run:

```powershell
npx vitest run tests/party-host.test.js tests/party-media.test.js
npm run test:legacy
node --test tests/public-live-regression.test.js
npx vitest run tests/contracts/secure-studio-baseline.test.js
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add studio/src/party-*.js studio/src/program-stream.js studio/src/main.js studio/index.html studio/src/studio.css tests/party-host.test.js tests/party-media.test.js tests/public-live-regression.test.js tests/contracts/secure-studio-baseline.test.js
git commit -m "feat: add host party moderation without changing public live"
```

## Task 9: Produce Versioned Assets and a Safe Homepage Patch

**Files:**
- Create: `scripts/assemble-party-release.mjs`
- Modify: `vite.party.config.js`
- Modify: `vite.studio.config.js`
- Modify: `index.html`
- Create: `tests/party-build.test.js`
- Create: `[SERVER_ROOT]/tools/patch_party_home.py`
- Create: `[SERVER_ROOT]/tools/party_release_guard.py`
- Create: `[SERVER_ROOT]/backend/tests/test_party_home_patch.py`
- Create: `[SERVER_ROOT]/backend/tests/test_party_release_guard.py`
- Modify: `[SERVER_ROOT]/infra/livekit/configure.py`
- Modify: `[SERVER_ROOT]/infra/livekit/tests/test_infra.py`
- Create on build: `dist/studio/index.html`, `dist/studio/assets/*`
- Create on build: `dist/studio/mediapipe/*`
- Create on build: `dist/party/manifest.json`, `dist/party/party-guest-v1.js`, `dist/party/party-room-v1.css`
- Create on build: `[SERVER_ROOT]/backend/live-studio/index.html`, `[SERVER_ROOT]/backend/live-studio/assets/*`
- Create on build: `[SERVER_ROOT]/public/files/live-party-v1/party-guest-v1.js`
- Create on build: `[SERVER_ROOT]/public/files/live-party-v1/party-room-v1.css`

**Interfaces:**
- Produces a manifest with SHA-256, source commit, filenames, and sizes for each asset.
- Produces `patch_homepage(html: str, expected_sha256: str, asset_base="/files/live-party-v1/") -> str`.
- The patcher replaces exactly one `DJCIOKO-GUEST-CHAT-V1` block or inserts exactly one party mount adjacent to the known live block; zero/multiple matches or a hash mismatch fail without output.
- Produces `capture_release_baseline(*, homepage, backend_root, database, environment, symlinks, backup_dir) -> Path` and `verify_release_baseline(manifest_path) -> None`. The capture copies each material input, records SHA-256 plus resolved symlink targets and a canonical backend tree manifest, and refuses missing/broad/root paths; verification fails if any active input changed after capture.

- [ ] **Step 1: Write failing deterministic-build tests**

Assert stable entry names, bundled LiveKit plus local pinned MediaPipe assets, no external LiveKit/PeerJS/MediaPipe CDN added by party assets, no secrets/source maps, manifest hashes matching bytes, byte-for-byte preservation of `stream.js`, `site-viewer-presence.js`, and the known root public-script blocks, and the generated protected studio base `/admin/live-studio/`.

- [ ] **Step 2: Run build tests and verify RED**

Run: `npx vitest run tests/party-build.test.js`
Expected: FAIL because the assembler/output does not exist.

- [ ] **Step 3: Implement the Vite entries and assembler**

Build the protected studio and guest asset separately and emit the fixed guest filenames plus manifest. `build:studio` must run the pinned MediaPipe copier after Vite, and `build:release` must run `build:studio`, `build:party`, then the deterministic assembler. Copy no old `studio/stream.js` from the divergent branch. Copy the full protected studio build, including local MediaPipe runtime files, into `[SERVER_ROOT]/backend/live-studio/` and the guest asset/shared CSS into `[SERVER_ROOT]/public/files/live-party-v1/`. Add only a same-origin secure-studio link to root `index.html`; do not load admin API code on GitHub Pages. Extend the deployment environment generator to emit `LIVE_PARTY_ENABLED=0` and `LIVE_PARTY_GUEST_ENABLED=0` without changing `LIVEKIT_ENABLED`.

- [ ] **Step 4: Write failing homepage patch tests**

Use fixtures for the captured production marker, canonical LiveKit-only page, hash mismatch, duplicate marker, already-patched idempotency, and preservation of PeerJS/public LiveKit script bytes and order. Release-guard tests cover complete backup/manifest, symlink targets, post-capture drift failure, missing input, and refusal of filesystem/workspace roots. Infrastructure tests must prove both party flags install disabled, repeat idempotently, and reject guest-enabled/host-disabled configuration.

- [ ] **Step 5: Run server patch tests and verify RED**

Run from `[SERVER_ROOT]`:

```powershell
& .\.venv\Scripts\python.exe -m pytest backend/tests/test_party_home_patch.py -q
```

Expected: FAIL because `patch_party_home.py` does not exist.

- [ ] **Step 6: Implement the fail-closed patcher and run both suites**

Run the frontend build/tests from `[FRONTEND_ROOT]`, then run the server test from `[SERVER_ROOT]`:

```powershell
npm run build:release
npx vitest run tests/party-build.test.js
Push-Location ..\djcioko-livekit-server
$env:PYTHONPATH = (Resolve-Path .\backend).Path
& .\.venv\Scripts\python.exe -m pytest backend\tests\test_party_home_patch.py backend\tests\test_party_release_guard.py infra\livekit\tests\test_infra.py -q
Pop-Location
```

Expected: build succeeds and all tests PASS. Do not patch or deploy production in this task.

- [ ] **Step 7: Commit both repositories**

Frontend:

```powershell
git add scripts/assemble-party-release.mjs vite.party.config.js vite.studio.config.js index.html tests/party-build.test.js
git commit -m "build: assemble versioned party assets"
```

Server clone:

```powershell
git add tools/patch_party_home.py tools/party_release_guard.py backend/tests/test_party_home_patch.py backend/tests/test_party_release_guard.py backend/live-studio public/files/live-party-v1 infra/livekit/configure.py infra/livekit/tests/test_infra.py
git commit -m "build: guard party homepage integration"
```

## Task 10: Automate Required Browser and Real-Transport Scenarios

**Files:**
- Create: `playwright.party.config.js`
- Create: `playwright.party-transport.config.js`
- Create: `tests/pw/party.spec.js`
- Create: `tests/pw/fixture/party-app.js`
- Create: `tests/pw-transport/party.pw.js`
- Create: `tests/pw-transport/support/party-grant-contract.js`
- Create: `tests/pw-transport/support/party-metrics.js`
- Modify: `package.json`

**Interfaces:**
- Fake-browser fixture exposes deterministic host/guest API and room events for UI/lifecycle tests.
- Real transport uses the deployed party APIs at `PARTY_TEST_BASE_URL`, authenticated host state from `PARTY_TEST_OWNER_STORAGE_STATE`, and refuses the literal production URL unless `PARTY_TEST_ALLOW_PRODUCTION=1` is explicitly set. It requires `PARTY_TEST_TURN_HOST`, `PARTY_TEST_METRICS_URL`, and a redacted `PARTY_TEST_METRICS_TOKEN` provider returning `{cpuPercent, memoryPercent, bandwidthBps}`.
- Metrics helper writes redacted JSON plus Playwright traces beneath `PARTY_TEST_REPORT_DIR` and records connect/reconnect time, selected ICE candidate pair, inbound/outbound bitrate, packet loss, active decoders, server metrics, and cleanup. No credential or display name enters the report.

- [ ] **Step 1: Write failing browser scenarios**

Create separately named Playwright tests for the actual root public page connecting/playing/counting/reconnecting/stopping through controlled PeerJS and public-LiveKit adapters; public LIVE remaining connected while a party guest joins, leaves, is removed, and the party closes; one guest; three guests; reconnect without duplicate; decline; 9 total and guest 9 refusal; voluntary leave; host remove; host close; permission denial; autoplay recovery; microphone/camera badge transitions; and 360/375/390 px layouts. The mobile/accessibility tests assert exact 1-column/2-column/up-to-3-column transitions, no horizontal overflow, every primary target at least 44×44 CSS pixels, Romanian accessible names, focus trap/return, safe-area padding, and disabled nonessential animation under `prefers-reduced-motion`.

- [ ] **Step 2: Run browser scenarios and verify RED**

Run: `npx playwright test --config=playwright.party.config.js`
Expected: FAIL because the party preview fixture/config is incomplete.

- [ ] **Step 3: Implement the deterministic preview fixture**

Serve the unmodified root page as well as host and guest built assets. Inject controlled PeerJS, public-LiveKit, party API, and party-room adapters before their real entry modules mount; run the real controllers and expose semantic selectors only. Avoid sleeps; wait for state/events, and assert the public adapter receives no party track, teardown, room, or identity.

- [ ] **Step 4: Run browser scenarios and verify GREEN**

Run the Task 10 browser command.
Expected: all named scenarios PASS on Chromium.

- [ ] **Step 5: Write the real 1/3/9-client transport probe**

Launch nine isolated browser contexts with fake camera/microphone devices and relay-only ICE. The probe must validate distinct identity-bound grants, one camera plus one microphone upload per client, all remote tiles/track statuses, selected candidate pairs whose remote type is `relay` and TURN host equals `PARTY_TEST_TURN_HOST`, reconnect within 10 seconds and before the 30-second grace expires, leave/remove/close cleanup within 10 seconds, no public-room tracks, and rejection of participant 10. Default duration is 20 minutes with sample interval 10 seconds; environment variables may shorten local smoke runs but not the pre-activation gate. The report fails if any client has a sustained 60-second packet-loss window of 5% or more, a duplicate decoder/tile, an unexpected publication, a non-relay selected pair, missing metrics samples, or if candidate server CPU reaches 80% or memory reaches 85%; raw metrics remain attached for capacity review.

- [ ] **Step 6: Run a short real-transport smoke test when the local/staging grant provider is available**

Run with the five required `PARTY_TEST_*` inputs: `npx playwright test --config=playwright.party-transport.config.js`
Expected: PASS with a redacted metrics artifact. If staging, TURN relay proof, host storage state, or the metrics provider is unavailable, preserve the executable probe and report the exact unavailable dependency; production activation remains blocked.

- [ ] **Step 7: Run the complete frontend suite**

```powershell
npm run test:legacy
npm test
npm run build:release
npx playwright test --config=playwright.party.config.js
```

Expected: all local frontend tests and build PASS with no warnings/errors.

- [ ] **Step 8: Run the complete server regression suite**

From `[SERVER_ROOT]`:

```powershell
$env:PYTHONPATH = (Resolve-Path .\backend).Path
& .\.venv\Scripts\python.exe -m pytest backend/tests/test_party_models.py backend/tests/test_party_v2.py backend/tests/test_livekit_gateway.py backend/tests/test_live_models.py backend/tests/test_live_v2.py backend/tests/test_live_factory.py backend/tests/test_live_access.py backend/tests/test_party_home_patch.py backend/tests/test_party_release_guard.py tests/contracts/test_livekit_home_player.py tests/contracts/test_no_secrets.py infra/livekit/tests/test_infra.py -q
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```powershell
git add playwright.party*.config.js tests/pw tests/pw-transport package.json package-lock.json
git commit -m "test: cover multiparty live room end to end"
```

## Final Review and Release Gate

- [ ] Compare the final implementation against every section of the approved spec.
- [ ] Run `git diff --check` and confirm both repositories are clean except for intentional commits.
- [ ] Have a fresh reviewer inspect the whole frontend and server branches, with special attention to the five Review Focus cases.
- [ ] Run `party_release_guard.py capture` on the deployment host for the active homepage, backend release, database, service environment, and every active release symlink. Compare its canonical backend tree manifest with source base `9196ede2b72db8d3df763a82949c19fccb52b1eb`; stop and reconcile any unplanned production-only drift into the candidate, then run `verify` immediately before promotion.
- [ ] Run public LIVE regression before any party flag is enabled.
- [ ] Run the full 20-minute nine-client transport test against the candidate deployment.
- [ ] Run one real mobile smoke test on the same-domain LiveKit/TURN path; verify all nine tiles can remain represented while adaptive quality lowers small tiles, and record device/browser/network because background camera operation remains unsupported.
- [ ] Back up the database, web release, service environment, and active symlink targets before any promotion.
- [ ] Enable `LIVE_PARTY_ENABLED` first, then `LIVE_PARTY_GUEST_ENABLED`; monitor room count, joins, reconnects, client errors, and LiveKit CPU/memory/bandwidth. Exercise rollback by disabling both flags, closing party rooms, and restoring the captured prior web/backend symlink targets and versioned assets without changing public LIVE.
- [ ] Do not call the feature production-ready if the real nine-client gate or production-source comparison is incomplete.
