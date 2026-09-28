// stream.js
// DJCIOKOSTUDIO LIVE + GUEST CHAT V1

let peerLive = null;
let broadcastStream = null;
let onlineViewerCounter = null;
let peerPartyHost = null;

/* =========================================================
   VIEWER COUNTER EXISTENT
   ========================================================= */

function createViewerPresenceHub(render) {
    const connections = new Set();
    const watchingConnections = new Set();

    function sendCount(connection, count) {
        if (!connection.open) return;

        try {
            connection.send({
                type: 'viewer-count',
                count
            });
        } catch (error) {
            console.warn(
                'Contorul live nu a putut fi trimis:',
                error
            );
        }
    }

    function broadcast() {
        const count = watchingConnections.size;

        render(count);

        connections.forEach(connection => {
            sendCount(connection, count);
        });
    }

    render(0);

    return {
        get value() {
            return watchingConnections.size;
        },

        attach(connection) {
            if (
                !connection ||
                connection.label !== 'viewer-presence'
            ) {
                return;
            }

            connections.add(connection);

            const remove = () => {
                const changed =
                    watchingConnections.delete(connection);

                connections.delete(connection);

                if (changed) {
                    broadcast();
                }
            };

            connection.on('data', message => {
                if (
                    !message ||
                    typeof message !== 'object'
                ) {
                    return;
                }

                if (
                    message.type === 'watching' &&
                    !watchingConnections.has(connection)
                ) {
                    watchingConnections.add(connection);
                    broadcast();
                }

                else if (
                    message.type === 'stopped' &&
                    watchingConnections.delete(connection)
                ) {
                    broadcast();
                }
            });

            connection.on('close', remove);
            connection.on('error', remove);

            sendCount(
                connection,
                watchingConnections.size
            );
        }
    };
}


/*
 * Păstrat pentru compatibilitate cu testele existente.
 */
function createOnlineViewerCounter(render) {
    const activeConnections = new Set();

    render(0);

    return {
        get value() {
            return activeConnections.size;
        },

        connect() {
            const token =
                Symbol('viewer');

            let connected = true;

            activeConnections.add(token);
            render(activeConnections.size);

            return () => {
                if (!connected) return;

                connected = false;

                activeConnections.delete(token);
                render(activeConnections.size);
            };
        }
    };
}


function renderOnlineViewerCount(value) {
    const viewerCount =
        document.getElementById('viewerCount');

    if (viewerCount) {
        viewerCount.textContent =
            String(value);
    }
}


/* =========================================================
   BROADCAST EXISTENT
   NU SCHIMBĂM LOGICA LIVE
   ========================================================= */

function attachMicrophoneToBroadcast() {
    if (
        !broadcastStream ||
        typeof localStream === 'undefined' ||
        !localStream
    ) {
        return false;
    }

    const microphoneTrack =
        localStream.getAudioTracks()[0];

    if (!microphoneTrack) {
        return false;
    }

    broadcastStream
        .getAudioTracks()
        .forEach(track => {
            broadcastStream.removeTrack(track);
        });

    broadcastStream.addTrack(
        microphoneTrack
    );

    return true;
}


async function waitForMicrophone() {
    for (
        let attempt = 0;
        attempt < 40;
        attempt += 1
    ) {
        if (attachMicrophoneToBroadcast()) {
            return true;
        }

        await new Promise(resolve =>
            setTimeout(resolve, 250)
        );
    }

    return false;
}


/* =========================================================
   PEERJS PARTY HOST (1 HOST + MAXIMUM 8 GUESTS)
   ========================================================= */

function createPeerPartyHostState({
    maxGuests = 8,
    expiryMs = 60000,
    initialPeerStatus = 'online',
    now = () => Date.now(),
    setTimer = (callback, delay) =>
        setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
    render = () => {},
    getHostState = () => ({
        mic: true,
        camera: true
    })
} = {}) {
    const pending = new Map();
    const accepted = new Map();
    const active = new Map();
    let peerStatus = initialPeerStatus;
    let roomRequestedOpen = true;
    let roomOpen = peerStatus === 'online';
    let order = 0;

    function ownsStablePeerId() {
        return peerStatus === 'online';
    }

    function cleanText(value, maxLength = 80) {
        return String(value || '')
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
            .trim()
            .slice(0, maxLength);
    }

    function cleanName(value) {
        return cleanText(value, 32)
            .replace(/\s+/g, ' ') ||
            'Invitat';
    }

    function send(connection, payload) {
        if (!connection || !connection.open) {
            return false;
        }

        try {
            connection.send(payload);
            return true;
        } catch (_) {
            return false;
        }
    }

    function publicEntry(record, state) {
        return {
            requestId: record.requestId,
            peerId: record.peerId,
            clientId: record.clientId,
            name: record.name,
            mic: record.mic,
            camera: record.camera,
            microphoneEnabled: record.mic,
            cameraEnabled: record.camera,
            state,
            expiresAt: record.expiresAt || null,
            stream: record.stream || null
        };
    }

    function snapshot() {
        return {
            roomOpen,
            peerStatus,
            peerReady: ownsStablePeerId(),
            capacity: maxGuests + 1,
            occupancy:
                1 + accepted.size + active.size,
            pending: [...pending.values()]
                .sort((left, right) =>
                    left.order - right.order)
                .map(record =>
                    publicEntry(record, 'pending')),
            accepted: [...accepted.values()]
                .sort((left, right) =>
                    left.order - right.order)
                .map(record =>
                    publicEntry(record, 'accepted')),
            active: [...active.values()]
                .sort((left, right) =>
                    left.order - right.order)
                .map(record =>
                    publicEntry(record, 'active'))
        };
    }

    function notifyRender() {
        try {
            render(snapshot());
        } catch (error) {
            console.warn(
                '[PARTY] Randarea gazdei a eșuat:',
                error
            );
        }
    }

    function clearExpiry(record) {
        if (!record || record.timer == null) {
            return;
        }

        clearTimer(record.timer);
        record.timer = null;
    }

    function findByRequestId(map, requestId) {
        for (const record of map.values()) {
            if (record.requestId === requestId) {
                return record;
            }
        }

        return null;
    }

    function findRecord(identifier) {
        const value = cleanText(identifier);

        for (const map of [active, accepted, pending]) {
            if (map.has(value)) {
                return {
                    map,
                    record: map.get(value)
                };
            }

            for (const record of map.values()) {
                if (
                    record.requestId === value ||
                    record.peerId === value
                ) {
                    return {map, record};
                }
            }
        }

        return null;
    }

    function expireRecord(map, record) {
        if (
            !record ||
            map.get(record.clientId) !== record
        ) {
            return;
        }

        clearExpiry(record);
        map.delete(record.clientId);
        send(record.connection, {
            type: 'guest-expired',
            requestId: record.requestId
        });
        broadcastRoster();
        notifyRender();
    }

    function armExpiry(map, record) {
        clearExpiry(record);
        record.expiresAt = now() + expiryMs;
        record.timer = setTimer(
            () => expireRecord(map, record),
            expiryMs
        );
    }

    function roster() {
        const hostState = getHostState() || {};
        const participants = [{
            peerId: 'djcioko-studio-unic-id',
            name: 'DJCIOKOSTUDIO',
            role: 'host',
            mic: hostState.mic !== false,
            camera: hostState.camera !== false,
            microphoneEnabled:
                hostState.mic !== false,
            cameraEnabled:
                hostState.camera !== false
        }];

        const guests = [...active.values()]
        .sort((left, right) =>
            left.order - right.order);

        guests.forEach(record => {
            participants.push({
                peerId: record.peerId,
                name: record.name,
                role: 'guest',
                mic: record.mic !== false,
                camera: record.camera !== false,
                microphoneEnabled:
                    record.mic !== false,
                cameraEnabled:
                    record.camera !== false
            });
        });

        return participants;
    }

    function broadcastRoster() {
        const message = {
            type: 'party-roster',
            roomOpen,
            capacity: maxGuests + 1,
            participants: roster()
        };
        const delivered = new Set();

        for (const record of [
            ...accepted.values(),
            ...active.values()
        ]) {
            if (
                record.connection &&
                !delivered.has(record.connection)
            ) {
                delivered.add(record.connection);
                send(record.connection, message);
            }
        }
    }

    function removeParticipant(
        identifier,
        {
            notify = true,
            messageType = 'guest-removed'
        } = {}
    ) {
        const found = findRecord(identifier);

        if (!found) {
            return false;
        }

        const {map, record} = found;
        map.delete(record.clientId);
        clearExpiry(record);

        if (notify) {
            send(record.connection, {
                type: messageType,
                requestId: record.requestId
            });
        }

        const call = record.call;
        record.call = null;
        record.stream = null;

        if (call) {
            try {
                call.close();
            } catch (_) {}
        }

        broadcastRoster();
        notifyRender();
        return true;
    }

    function requestRecord(message, connection) {
        const requestId = cleanText(message.requestId);
        const connectionPeer = cleanText(connection.peer);
        const peerId = cleanText(
            message.peerId || connectionPeer
        );
        const clientId = cleanText(message.clientId);

        if (
            !requestId ||
            !peerId ||
            !clientId ||
            (connectionPeer && peerId !== connectionPeer)
        ) {
            send(connection, {
                type: 'guest-invalid',
                requestId
            });
            return null;
        }

        return {
            requestId,
            peerId,
            clientId,
            name: cleanName(message.name),
            connection,
            mic:
                typeof message.microphoneEnabled ===
                    'boolean'
                    ? message.microphoneEnabled
                    : message.mic !== false,
            camera:
                typeof message.cameraEnabled ===
                    'boolean'
                    ? message.cameraEnabled
                    : message.camera !== false
        };
    }

    function updateRecord(record, update) {
        record.requestId = update.requestId;
        record.peerId = update.peerId;
        record.name = update.name;
        record.connection = update.connection;
        record.mic = update.mic;
        record.camera = update.camera;
        return record;
    }

    function receiveRequest(connection, message) {
        const update = requestRecord(
            message,
            connection
        );

        if (!update) {
            return;
        }

        if (!roomOpen) {
            send(connection, {
                type: 'room-closed',
                requestId: update.requestId
            });
            return;
        }

        const activeRecord =
            active.get(update.clientId);
        const acceptedRecord =
            accepted.get(update.clientId);
        const pendingRecord =
            pending.get(update.clientId);

        if (activeRecord || acceptedRecord) {
            const record = updateRecord(
                activeRecord || acceptedRecord,
                update
            );

            if (acceptedRecord) {
                armExpiry(accepted, record);
            }

            send(connection, {
                type: 'guest-accepted',
                requestId: record.requestId
            });
            broadcastRoster();
            notifyRender();
            return;
        }

        const record = pendingRecord
            ? updateRecord(pendingRecord, update)
            : {
                ...update,
                order: ++order,
                timer: null,
                expiresAt: null,
                call: null,
                stream: null
            };

        pending.set(record.clientId, record);
        armExpiry(pending, record);
        send(connection, {
            type: 'guest-pending',
            requestId: record.requestId,
            expiresAt: record.expiresAt
        });
        notifyRender();
    }

    function updateParticipantState(
        connection,
        message
    ) {
        const clientId = cleanText(message.clientId);
        const requestId = cleanText(message.requestId);
        let record =
            active.get(clientId) ||
            accepted.get(clientId);

        if (!record && requestId) {
            record =
                findByRequestId(active, requestId) ||
                findByRequestId(accepted, requestId);
        }

        if (
            !record ||
            (
                record.connection &&
                record.connection !== connection
            )
        ) {
            return;
        }

        if (
            typeof message.microphoneEnabled ===
                'boolean'
        ) {
            record.mic = message.microphoneEnabled;
        } else if (typeof message.mic === 'boolean') {
            record.mic = message.mic;
        }

        if (
            typeof message.cameraEnabled ===
                'boolean'
        ) {
            record.camera = message.cameraEnabled;
        } else if (typeof message.camera === 'boolean') {
            record.camera = message.camera;
        }

        broadcastRoster();
        notifyRender();
    }

    function guestLeft(connection, message) {
        const clientId = cleanText(message.clientId);
        const requestId = cleanText(message.requestId);
        const found = findRecord(
            clientId || requestId
        );

        if (
            found &&
            (!found.record.connection ||
                found.record.connection === connection)
        ) {
            removeParticipant(
                found.record.clientId,
                {notify: false}
            );
        }
    }

    function attachConnection(connection) {
        if (
            !connection ||
            connection.label !== 'guest-request' ||
            !ownsStablePeerId()
        ) {
            return false;
        }

        connection.on('data', message => {
            if (
                !ownsStablePeerId() ||
                !message ||
                typeof message !== 'object'
            ) {
                return;
            }

            if (message.type === 'guest-request') {
                receiveRequest(connection, message);
            } else if (
                message.type === 'party-status-request'
            ) {
                send(connection, {
                    type: 'party-status',
                    open: roomOpen,
                    capacity: maxGuests + 1,
                    occupancy:
                        1 + accepted.size + active.size
                });
            } else if (
                message.type === 'participant-state' ||
                message.type === 'guest-state'
            ) {
                updateParticipantState(
                    connection,
                    message
                );
            } else if (message.type === 'guest-left') {
                guestLeft(connection, message);
            }
        });

        const disconnected = () => {
            for (const map of [
                pending,
                accepted,
                active
            ]) {
                for (const record of map.values()) {
                    if (record.connection === connection) {
                        record.connection = null;
                    }
                }
            }

            notifyRender();
        };

        connection.on('close', disconnected);
        connection.on('error', disconnected);
        return true;
    }

    function acceptRequest(requestId) {
        const cleanRequestId = cleanText(requestId);
        const existing =
            findByRequestId(accepted, cleanRequestId) ||
            findByRequestId(active, cleanRequestId);

        if (existing) {
            send(existing.connection, {
                type: 'guest-accepted',
                requestId: existing.requestId
            });
            broadcastRoster();
            return true;
        }

        const record =
            findByRequestId(pending, cleanRequestId);

        if (!record || !roomOpen) {
            return false;
        }

        if (
            accepted.size + active.size >=
            maxGuests
        ) {
            send(record.connection, {
                type: 'guest-busy',
                requestId: record.requestId,
                reason: 'room-full'
            });
            return false;
        }

        pending.delete(record.clientId);
        clearExpiry(record);
        accepted.set(record.clientId, record);
        armExpiry(accepted, record);
        send(record.connection, {
            type: 'guest-accepted',
            requestId: record.requestId
        });
        broadcastRoster();
        notifyRender();
        return true;
    }

    function declineRequest(requestId) {
        const record = findByRequestId(
            pending,
            cleanText(requestId)
        );

        if (!record) {
            return false;
        }

        pending.delete(record.clientId);
        clearExpiry(record);
        send(record.connection, {
            type: 'guest-rejected',
            requestId: record.requestId
        });
        notifyRender();
        return true;
    }

    function trackState(record, track, value) {
        if (!track) return;

        const update = enabled => {
            record[value] = enabled;
            broadcastRoster();
            notifyRender();
        };

        if (typeof track.addEventListener === 'function') {
            track.addEventListener('mute', () => update(false));
            track.addEventListener('unmute', () => update(true));
            track.addEventListener('ended', () => update(false));
        }
    }

    function reserveForReconnect(record, call) {
        if (
            active.get(record.clientId) !== record ||
            record.call !== call
        ) {
            return;
        }

        active.delete(record.clientId);
        record.call = null;
        record.stream = null;
        record.mic = false;
        record.camera = false;

        if (roomOpen) {
            accepted.set(record.clientId, record);
            armExpiry(accepted, record);
            send(record.connection, {
                type: 'guest-reconnect',
                requestId: record.requestId,
                expiresAt: record.expiresAt
            });
        }

        broadcastRoster();
        notifyRender();
    }

    function acceptMediaCall(call, answerStream) {
        const metadata = call && call.metadata || {};

        if (
            !call ||
            !ownsStablePeerId() ||
            metadata.type !== 'guest-chat'
        ) {
            if (call && !ownsStablePeerId()) {
                try {
                    call.close();
                } catch (_) {}
            }
            return false;
        }

        const clientId = cleanText(metadata.clientId);
        const requestId = cleanText(metadata.requestId);
        let record =
            accepted.get(clientId) ||
            active.get(clientId);

        if (!record && requestId) {
            record =
                findByRequestId(accepted, requestId) ||
                findByRequestId(active, requestId);
        }

        if (
            !record ||
            call.peer !== record.peerId ||
            (
                requestId &&
                requestId !== record.requestId
            )
        ) {
            try {
                call.close();
            } catch (_) {}
            return false;
        }

        accepted.delete(record.clientId);
        clearExpiry(record);

        const previousCall = record.call;
        record.call = call;
        record.stream = null;
        record.mic =
            typeof metadata.microphoneEnabled ===
                'boolean'
                ? metadata.microphoneEnabled
                : metadata.mic !== false;
        record.camera =
            typeof metadata.cameraEnabled ===
                'boolean'
                ? metadata.cameraEnabled
                : metadata.camera !== false;
        active.set(record.clientId, record);

        call.on('stream', remoteStream => {
            if (
                active.get(record.clientId) !== record ||
                record.call !== call
            ) {
                return;
            }

            record.stream = remoteStream;
            const audioTrack =
                remoteStream?.getAudioTracks?.()[0];
            const videoTrack =
                remoteStream?.getVideoTracks?.()[0];
            record.mic = audioTrack
                ? audioTrack.enabled !== false &&
                    audioTrack.muted !== true
                : false;
            record.camera = videoTrack
                ? videoTrack.enabled !== false &&
                    videoTrack.muted !== true
                : false;
            trackState(record, audioTrack, 'mic');
            trackState(record, videoTrack, 'camera');
            broadcastRoster();
            notifyRender();
        });

        call.on('close', () =>
            reserveForReconnect(record, call));
        call.on('error', () =>
            reserveForReconnect(record, call));

        try {
            call.answer(answerStream);
        } catch (_) {
            active.delete(record.clientId);
            record.call = null;
            accepted.set(record.clientId, record);
            armExpiry(accepted, record);
            notifyRender();
            return false;
        }

        if (previousCall && previousCall !== call) {
            try {
                previousCall.close();
            } catch (_) {}
        }

        broadcastRoster();
        notifyRender();
        return true;
    }

    function closeRoom() {
        roomRequestedOpen = false;
        roomOpen = false;
        const records = [
            ...pending.values(),
            ...accepted.values(),
            ...active.values()
        ];
        pending.clear();
        accepted.clear();
        active.clear();

        records.forEach(record => {
            clearExpiry(record);
            send(record.connection, {
                type: 'room-closed',
                requestId: record.requestId
            });

            if (record.call) {
                try {
                    record.call.close();
                } catch (_) {}
            }
        });

        notifyRender();
        return true;
    }

    function openRoom() {
        roomRequestedOpen = true;
        roomOpen = ownsStablePeerId();
        broadcastRoster();
        notifyRender();
        return true;
    }

    function setPeerStatus(status) {
        if (
            status !== 'connecting' &&
            status !== 'online' &&
            status !== 'reconnecting' &&
            status !== 'unavailable'
        ) {
            return false;
        }

        if (
            peerStatus === 'unavailable' &&
            status === 'reconnecting'
        ) {
            return false;
        }

        peerStatus = status;
        roomOpen = ownsStablePeerId() &&
            roomRequestedOpen;

        if (roomOpen) {
            broadcastRoster();
        }

        notifyRender();
        return true;
    }

    function refresh() {
        broadcastRoster();
        notifyRender();
    }

    function destroy() {
        closeRoom();
    }

    notifyRender();

    return {
        pending,
        accepted,
        active,
        snapshot,
        roster,
        attachConnection,
        acceptRequest,
        declineRequest,
        acceptMediaCall,
        removeParticipant,
        closeRoom,
        openRoom,
        setPeerStatus,
        ownsStablePeerId,
        refresh,
        destroy
    };
}


function createPeerPartyHostUiModel(state) {
    const peerStatus = state.peerStatus || 'online';
    const peerReady =
        peerStatus === 'online' &&
        state.peerReady !== false;
    let statusText;
    let badgeText;

    if (peerStatus === 'unavailable') {
        statusText =
            'DJCIOKOSTUDIO este deja deschisă în altă filă. Închide cealaltă filă și reîncarcă pagina.';
        badgeText = 'DEJA DESCHISĂ';
    } else if (peerStatus === 'reconnecting') {
        statusText =
            'Conexiunea PeerJS s-a întrerupt. Se reconectează…';
        badgeText = 'PEERJS RECONECTARE';
    } else if (!peerReady) {
        statusText = 'Se conectează la PeerJS…';
        badgeText = 'PEERJS CONECTARE';
    } else {
        statusText = state.roomOpen
            ? 'PeerJS conectat. Camera este deschisă pentru cereri.'
            : 'PeerJS conectat. Camera este închisă.';
        badgeText = 'PEERJS ONLINE';
    }

    return {
        statusText,
        badgeText,
        openButtonDisabled:
            !peerReady || state.roomOpen,
        closeButtonDisabled:
            !peerReady || !state.roomOpen,
        requestControlsDisabled: !peerReady
    };
}


function ensurePeerPartyHostUi() {
    let root = document.getElementById(
        'djPeerPartyHost'
    );

    if (root) {
        return root;
    }

    const style = document.createElement('style');
    style.id = 'djPeerPartyHostStyle';
    style.textContent = `
      #djPeerPartyHost{margin:14px 10px 0;padding:13px;border:1px solid #2a5570;border-radius:14px;background:#0a1721;color:#eaf6ff;font-family:Georgia,serif}
      #djPeerPartyHost *{box-sizing:border-box}
      .dj-party-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
      .dj-party-head strong{color:#b9e4ff;font-size:13px;letter-spacing:.04em}
      .dj-party-count{padding:4px 8px;border-radius:20px;background:#123044;color:#9fe8ff;font-size:11px;font-weight:bold}
      .dj-party-status{margin:5px 0 10px;color:#9bb6c9;font-size:11px}
      .dj-party-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:10px}
      .dj-party-actions button,.dj-party-request button,.dj-party-remove{min-height:40px;border:1px solid #4d86aa;border-radius:9px;padding:8px;background:#194c6d;color:#fff;font:700 11px Georgia,serif;cursor:pointer}
      .dj-party-actions button[disabled]{opacity:.4;cursor:not-allowed}
      .dj-party-close{background:#8b2937!important;border-color:#b74d5c!important}
      .dj-party-requests{display:grid;gap:7px;margin-bottom:10px}
      .dj-party-empty{padding:9px;text-align:center;color:#7f9aae;font-size:11px;border:1px dashed #244257;border-radius:9px}
      .dj-party-request{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px;padding:8px;border-radius:10px;background:#0d2230;border:1px solid #24485f}
      .dj-party-request-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:bold}
      .dj-party-request .reject{background:#782a36;border-color:#9e4050}
      .dj-party-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .dj-party-tile{position:relative;min-width:0;overflow:hidden;border:1px solid #2a5570;border-radius:11px;background:#02070b;aspect-ratio:9/13}
      .dj-party-video,.dj-party-placeholder{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
      .dj-party-placeholder{display:flex;align-items:center;justify-content:center;color:#7ecbff;font-size:30px}
      .dj-party-meta{position:absolute;left:0;right:0;bottom:0;padding:28px 7px 7px;background:linear-gradient(transparent,rgba(0,0,0,.9));font-size:10px}
      .dj-party-meta strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;font-size:11px}
      .dj-party-state{display:block;margin-top:3px;color:#b9e4ff}
      .dj-party-remove{position:absolute;right:5px;top:5px;z-index:2;min-height:32px;padding:5px 7px;background:#8b2937;border-color:#b74d5c;font-size:9px}
      @media (min-width:390px){.dj-party-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);

    root = document.createElement('section');
    root.id = 'djPeerPartyHost';
    root.setAttribute(
        'aria-label',
        'Camera PeerJS cu invitați'
    );
    root.innerHTML = `
      <div class="dj-party-head">
        <strong>LIVE CU INVITAȚI · PEERJS</strong>
        <span class="dj-party-count" id="djPeerPartyCount">1/9</span>
      </div>
      <p class="dj-party-status" id="djPeerPartyStatus" aria-live="polite">Se conectează la PeerJS…</p>
      <div class="dj-party-actions">
        <button type="button" id="djPeerPartyOpen" disabled>Deschide camera</button>
        <button type="button" id="djPeerPartyClose" class="dj-party-close" disabled>Închide camera</button>
      </div>
      <div class="dj-party-requests" id="djPeerPartyRequests"></div>
      <div class="dj-party-grid" id="djPeerPartyGrid" aria-label="Invitați conectați"></div>
    `;

    const mount =
        document.querySelector('.main-content') ||
        document.body;
    mount.appendChild(root);

    document
        .getElementById('djPeerPartyOpen')
        .addEventListener('click', () => {
            peerPartyHost?.openRoom();
        });

    document
        .getElementById('djPeerPartyClose')
        .addEventListener('click', () => {
            const state = peerPartyHost?.snapshot();
            const hasGuests = Boolean(
                state &&
                (
                    state.pending.length ||
                    state.accepted.length ||
                    state.active.length
                )
            );

            if (
                hasGuests &&
                typeof window.confirm === 'function' &&
                !window.confirm(
                    'Închizi camera pentru toți invitații?'
                )
            ) {
                return;
            }

            peerPartyHost?.closeRoom();
        });

    ['btnMic', 'btnVideoToggle'].forEach(id => {
        document.getElementById(id)?.addEventListener(
            'click',
            () => setTimeout(
                () => peerPartyHost?.refresh(),
                0
            )
        );
    });

    return root;
}


function renderPeerPartyHostState(state) {
    const root = ensurePeerPartyHostUi();
    const uiModel = createPeerPartyHostUiModel(state);
    const count = root.querySelector(
        '#djPeerPartyCount'
    );
    const status = root.querySelector(
        '#djPeerPartyStatus'
    );
    const openButton = root.querySelector(
        '#djPeerPartyOpen'
    );
    const closeButton = root.querySelector(
        '#djPeerPartyClose'
    );
    const requests = root.querySelector(
        '#djPeerPartyRequests'
    );
    const grid = root.querySelector(
        '#djPeerPartyGrid'
    );

    count.textContent =
        `${state.occupancy}/${state.capacity}`;
    status.textContent = uiModel.statusText;
    openButton.disabled = uiModel.openButtonDisabled;
    closeButton.disabled = uiModel.closeButtonDisabled;
    root.dataset.peerStatus = state.peerStatus;

    const headerBadge = document.querySelector(
        '[data-peer-host-status]'
    );

    if (headerBadge) {
        headerBadge.textContent = uiModel.badgeText;
    }

    requests.replaceChildren();

    if (!state.pending.length) {
        const empty = document.createElement('p');
        empty.className = 'dj-party-empty';
        empty.textContent = state.roomOpen
            ? 'Nicio cerere momentan.'
            : 'Deschide camera pentru a primi cereri.';
        requests.appendChild(empty);
    } else {
        state.pending.forEach(entry => {
            const row = document.createElement('div');
            row.className = 'dj-party-request';
            const name = document.createElement('span');
            name.className = 'dj-party-request-name';
            name.textContent = entry.name;
            const accept = document.createElement('button');
            accept.type = 'button';
            accept.textContent = 'Acceptă';
            accept.disabled =
                uiModel.requestControlsDisabled ||
                state.occupancy >= state.capacity;
            accept.addEventListener(
                'click',
                () => peerPartyHost?.acceptRequest(
                    entry.requestId
                )
            );
            const reject = document.createElement('button');
            reject.type = 'button';
            reject.className = 'reject';
            reject.textContent = 'Respinge';
            reject.disabled =
                uiModel.requestControlsDisabled;
            reject.addEventListener(
                'click',
                () => peerPartyHost?.declineRequest(
                    entry.requestId
                )
            );
            row.append(name, accept, reject);
            requests.appendChild(row);
        });
    }

    const guests = [
        ...state.accepted,
        ...state.active
    ].sort((left, right) =>
        left.name.localeCompare(
            right.name,
            'ro'
        ));
    grid.replaceChildren();

    guests.forEach(entry => {
        const tile = document.createElement('article');
        tile.className = 'dj-party-tile';
        tile.dataset.clientId = entry.clientId;

        if (entry.stream) {
            const video = document.createElement('video');
            video.className = 'dj-party-video';
            video.autoplay = true;
            video.playsInline = true;
            video.controls = true;
            video.srcObject = entry.stream;
            video.play().catch(() => {});
            tile.appendChild(video);
        } else {
            const placeholder =
                document.createElement('div');
            placeholder.className =
                'dj-party-placeholder';
            placeholder.textContent =
                (entry.name[0] || '?').toUpperCase();
            tile.appendChild(placeholder);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'dj-party-remove';
        remove.textContent = 'Elimină';
        remove.disabled =
            uiModel.requestControlsDisabled;
        remove.setAttribute(
            'aria-label',
            `Elimină ${entry.name}`
        );
        remove.addEventListener(
            'click',
            () => peerPartyHost?.removeParticipant(
                entry.clientId
            )
        );

        const meta = document.createElement('div');
        meta.className = 'dj-party-meta';
        const name = document.createElement('strong');
        name.textContent = entry.name;
        const devices = document.createElement('span');
        devices.className = 'dj-party-state';
        devices.textContent =
            `${entry.mic ? '🎙️' : '🔇'} ${entry.camera ? '📹' : '📷 oprită'} · ${entry.state === 'active' ? 'conectat' : 'se conectează'}`;
        meta.append(name, devices);
        tile.append(remove, meta);
        grid.appendChild(tile);
    });
}


/* =========================================================
   GUEST CHAT
   ========================================================= */

let pendingGuestRequest = null;
let acceptedGuestRequest = null;
let acceptedGuestTimer = null;

let activeGuestCall = null;
let activeGuestStream = null;


function sendGuestMessage(connection, payload) {
    if (
        !connection ||
        !connection.open
    ) {
        return false;
    }

    try {
        connection.send(payload);
        return true;
    } catch (error) {
        console.warn(
            '[GUEST] send failed:',
            error
        );

        return false;
    }
}


function ensureGuestUi() {
    let root =
        document.getElementById(
            'djGuestHostUi'
        );

    if (!root) {
        root =
            document.createElement('div');

        root.id =
            'djGuestHostUi';

        root.innerHTML = `
          <div id="djGuestRequest"
               style="
                 display:none;
                 position:fixed;
                 left:12px;
                 right:12px;
                 bottom:16px;
                 z-index:99999;
                 padding:14px;
                 border-radius:16px;
                 background:#101822;
                 border:1px solid #4d86aa;
                 box-shadow:0 10px 40px rgba(0,0,0,.55);
                 color:white;
                 font-family:Georgia,serif
               ">

            <div style="
                 font-weight:bold;
                 color:#b9e4ff;
                 margin-bottom:10px;
                 text-align:center
            ">
              ✋ Un spectator vrea să intre în direct
            </div>

            <div style="
                 display:grid;
                 grid-template-columns:1fr 1fr;
                 gap:8px
            ">
              <button id="djGuestAccept"
                      type="button"
                      style="
                        padding:11px;
                        border:0;
                        border-radius:10px;
                        background:#1f8f55;
                        color:white;
                        font-weight:bold
                      ">
                ✅ ACCEPTĂ
              </button>

              <button id="djGuestReject"
                      type="button"
                      style="
                        padding:11px;
                        border:0;
                        border-radius:10px;
                        background:#9e3040;
                        color:white;
                        font-weight:bold
                      ">
                ❌ RESPINGE
              </button>
            </div>
          </div>


          <div id="djGuestChat"
               style="
                 display:none;
                 position:fixed;
                 inset:0;
                 z-index:99998;
                 background:rgba(2,7,12,.94);
                 padding:12px;
                 color:white;
                 font-family:Georgia,serif
               ">

            <div style="
                 max-width:430px;
                 margin:0 auto
            ">

              <div style="
                   display:flex;
                   justify-content:space-between;
                   align-items:center;
                   margin-bottom:8px
              ">
                <strong>
                  🎥 INVITAT LIVE
                </strong>

                <button id="djGuestEnd"
                        type="button"
                        style="
                          border:0;
                          border-radius:9px;
                          padding:8px 12px;
                          background:#a72f3d;
                          color:white;
                          font-weight:bold
                        ">
                  ÎNCHIDE
                </button>
              </div>

              <div id="djGuestHostStatus"
                   style="
                     color:#b9e4ff;
                     font-size:12px;
                     margin-bottom:8px
                   ">
                Aștept camera invitatului...
              </div>

              <video id="djGuestRemoteVideo"
                     autoplay
                     playsinline
                     controls
                     style="
                       width:100%;
                       max-height:70vh;
                       background:#000;
                       border-radius:14px;
                       border:1px solid #2a5570
                     ">
              </video>
            </div>
          </div>
        `;

        document.body.appendChild(root);

        document
            .getElementById('djGuestAccept')
            .addEventListener(
                'click',
                acceptPendingGuest
            );

        document
            .getElementById('djGuestReject')
            .addEventListener(
                'click',
                rejectPendingGuest
            );

        document
            .getElementById('djGuestEnd')
            .addEventListener(
                'click',
                () => {
                    finishGuestChat({
                        notifyGuest: true,
                        closeCall: true
                    });
                }
            );
    }

    return {
        request:
            document.getElementById(
                'djGuestRequest'
            ),

        chat:
            document.getElementById(
                'djGuestChat'
            ),

        status:
            document.getElementById(
                'djGuestHostStatus'
            ),

        video:
            document.getElementById(
                'djGuestRemoteVideo'
            )
    };
}


function hideGuestRequest() {
    const ui = ensureGuestUi();

    ui.request.style.display =
        'none';
}


function showGuestRequest() {
    const ui = ensureGuestUi();

    ui.request.style.display =
        'block';
}


function acceptPendingGuest() {
    if (!pendingGuestRequest) {
        return;
    }

    if (
        activeGuestCall ||
        acceptedGuestRequest
    ) {
        sendGuestMessage(
            pendingGuestRequest.connection,
            {
                type: 'guest-busy',
                requestId:
                    pendingGuestRequest.requestId
            }
        );

        pendingGuestRequest = null;
        hideGuestRequest();

        return;
    }


    acceptedGuestRequest =
        pendingGuestRequest;

    pendingGuestRequest = null;

    hideGuestRequest();


    const ui = ensureGuestUi();

    ui.chat.style.display =
        'block';

    ui.status.textContent =
        'Cerere acceptată. Aștept camera și microfonul invitatului...';


    sendGuestMessage(
        acceptedGuestRequest.connection,
        {
            type: 'guest-accepted',
            requestId:
                acceptedGuestRequest.requestId
        }
    );


    if (acceptedGuestTimer) {
        clearTimeout(
            acceptedGuestTimer
        );
    }


    /*
     * Dacă spectatorul nu pornește camera
     * în 30 secunde, anulăm sesiunea.
     */
    acceptedGuestTimer =
        setTimeout(() => {
            acceptedGuestTimer = null;

            if (
                acceptedGuestRequest &&
                !activeGuestCall
            ) {
                sendGuestMessage(
                    acceptedGuestRequest.connection,
                    {
                        type: 'host-ended',
                        requestId:
                            acceptedGuestRequest
                                .requestId
                    }
                );

                acceptedGuestRequest =
                    null;

                ui.chat.style.display =
                    'none';

                if (
                    typeof showToast ===
                    'function'
                ) {
                    showToast(
                        'Invitatul nu s-a conectat.'
                    );
                }
            }
        }, 30000);
}


function rejectPendingGuest() {
    if (!pendingGuestRequest) {
        return;
    }

    sendGuestMessage(
        pendingGuestRequest.connection,
        {
            type: 'guest-rejected',
            requestId:
                pendingGuestRequest.requestId
        }
    );

    pendingGuestRequest = null;

    hideGuestRequest();
}


function finishGuestChat({
    notifyGuest = false,
    closeCall = true
} = {}) {

    if (acceptedGuestTimer) {
        clearTimeout(
            acceptedGuestTimer
        );

        acceptedGuestTimer = null;
    }


    const request =
        acceptedGuestRequest;

    acceptedGuestRequest = null;


    if (
        notifyGuest &&
        request
    ) {
        sendGuestMessage(
            request.connection,
            {
                type: 'host-ended',
                requestId:
                    request.requestId
            }
        );
    }


    const oldCall =
        activeGuestCall;

    activeGuestCall = null;


    if (
        closeCall &&
        oldCall
    ) {
        try {
            oldCall.close();
        } catch (_) {}
    }


    activeGuestStream = null;


    const ui = ensureGuestUi();

    try {
        ui.video.pause();
        ui.video.srcObject = null;
    } catch (_) {}


    ui.chat.style.display =
        'none';

    ui.status.textContent =
        'Aștept invitat...';
}


function handleGuestRequestConnection(
    connection
) {

    connection.on(
        'data',
        message => {

            if (
                !message ||
                typeof message !== 'object'
            ) {
                return;
            }


            if (
                message.type ===
                'guest-request'
            ) {
                const requestId =
                    String(
                        message.requestId ||
                        ''
                    );

                const peerId =
                    String(
                        message.peerId ||
                        connection.peer ||
                        ''
                    );


                if (
                    !requestId ||
                    !peerId
                ) {
                    return;
                }


                /*
                 * Un singur invitat simultan.
                 */
                if (
                    activeGuestCall ||
                    acceptedGuestRequest ||
                    pendingGuestRequest
                ) {
                    sendGuestMessage(
                        connection,
                        {
                            type: 'guest-busy',
                            requestId
                        }
                    );

                    return;
                }


                pendingGuestRequest = {
                    requestId,
                    peerId,
                    connection
                };


                showGuestRequest();


                if (
                    typeof showToast ===
                    'function'
                ) {
                    showToast(
                        '✋ Un spectator vrea să intre în direct!'
                    );
                }

                return;
            }


            if (
                message.type ===
                'guest-left'
            ) {
                const requestId =
                    String(
                        message.requestId ||
                        ''
                    );


                if (
                    pendingGuestRequest &&
                    pendingGuestRequest
                        .requestId ===
                        requestId
                ) {
                    pendingGuestRequest =
                        null;

                    hideGuestRequest();
                }


                if (
                    acceptedGuestRequest &&
                    acceptedGuestRequest
                        .requestId ===
                        requestId
                ) {
                    finishGuestChat({
                        notifyGuest: false,
                        closeCall: true
                    });
                }

                return;
            }


            if (
                message.type ===
                'guest-media-error'
            ) {
                if (
                    acceptedGuestRequest &&
                    acceptedGuestRequest
                        .requestId ===
                        String(
                            message.requestId ||
                            ''
                        )
                ) {
                    finishGuestChat({
                        notifyGuest: false,
                        closeCall: true
                    });

                    if (
                        typeof showToast ===
                        'function'
                    ) {
                        showToast(
                            'Invitatul nu a permis camera sau microfonul.'
                        );
                    }
                }
            }
        }
    );


    const closed = () => {
        if (
            pendingGuestRequest &&
            pendingGuestRequest
                .connection ===
                connection
        ) {
            pendingGuestRequest =
                null;

            hideGuestRequest();
        }


        if (
            acceptedGuestRequest &&
            acceptedGuestRequest
                .connection ===
                connection &&
            !activeGuestCall
        ) {
            acceptedGuestRequest =
                null;

            const ui =
                ensureGuestUi();

            ui.chat.style.display =
                'none';
        }
    };


    connection.on(
        'close',
        closed
    );

    connection.on(
        'error',
        closed
    );
}


async function handleGuestMediaCall(
    call
) {
    const metadata =
        call.metadata || {};

    const requestId =
        String(
            metadata.requestId ||
            ''
        );


    /*
     * Nu permitem apel direct fără Accept.
     */
    if (
        !acceptedGuestRequest ||
        acceptedGuestRequest
            .requestId !==
            requestId
    ) {
        try {
            call.close();
        } catch (_) {}

        return;
    }


    if (
        acceptedGuestRequest.peerId &&
        call.peer !==
            acceptedGuestRequest.peerId
    ) {
        try {
            call.close();
        } catch (_) {}

        return;
    }


    if (activeGuestCall) {
        sendGuestMessage(
            acceptedGuestRequest.connection,
            {
                type: 'guest-busy',
                requestId
            }
        );

        try {
            call.close();
        } catch (_) {}

        return;
    }


    if (acceptedGuestTimer) {
        clearTimeout(
            acceptedGuestTimer
        );

        acceptedGuestTimer = null;
    }


    activeGuestCall = call;


    const ui =
        ensureGuestUi();

    ui.chat.style.display =
        'block';

    ui.status.textContent =
        'Se conectează invitatul...';


    /*
     * Primim video/audio de la spectator.
     */
    call.on(
        'stream',
        async remoteStream => {

            if (
                activeGuestCall !== call
            ) {
                return;
            }


            activeGuestStream =
                remoteStream;

            ui.video.srcObject =
                remoteStream;


            try {
                await ui.video.play();

                ui.status.textContent =
                    '🔴 Invitat conectat audio/video';

            } catch (_) {
                ui.status.textContent =
                    'Invitat conectat. Apasă Play pentru audio.';
            }
        }
    );


    call.on(
        'close',
        () => {
            if (
                activeGuestCall !== call
            ) {
                return;
            }

            finishGuestChat({
                notifyGuest: false,
                closeCall: false
            });
        }
    );


    call.on(
        'error',
        error => {
            console.warn(
                '[GUEST] media call:',
                error
            );

            if (
                activeGuestCall !== call
            ) {
                return;
            }

            finishGuestChat({
                notifyGuest: false,
                closeCall: false
            });
        }
    );


    /*
     * Trimitem spectatorului aceeași imagine
     * și același audio pe care le folosește
     * deja DJCIOKOSTUDIO pentru LIVE.
     */
    await waitForMicrophone();


    if (
        activeGuestCall !== call
    ) {
        return;
    }


    call.answer(
        broadcastStream
    );


    console.log(
        '[GUEST] Chat acceptat:',
        call.peer
    );
}


/* =========================================================
   PEERJS
   ========================================================= */

function attachPeerPartyHostLifecycle(
    peer,
    host,
    {
        onOpen = () => {},
        onDisconnected = () => {},
        onError = () => {}
    } = {}
) {
    peer.on('open', id => {
        host.setPeerStatus('online');
        onOpen(id);
    });

    peer.on('disconnected', () => {
        host.setPeerStatus('reconnecting');
        onDisconnected();
    });

    peer.on('error', error => {
        if (
            error &&
            error.type === 'unavailable-id'
        ) {
            host.setPeerStatus('unavailable');
        }

        onError(error);
    });
}

function initStudioBroadcast() {

    if (
        typeof Peer === 'undefined'
    ) {
        console.error(
            'Biblioteca PeerJS nu este încărcată!'
        );

        return;
    }


    const canvasEl =
        document.querySelector('canvas');

    if (!canvasEl) {
        console.error(
            'Canvas-ul de emisie nu a fost găsit!'
        );

        return;
    }


    /*
     * LIVE-ul existent rămâne neschimbat.
     */
    broadcastStream =
        canvasEl.captureStream(30);


    onlineViewerCounter =
        createViewerPresenceHub(
            renderOnlineViewerCount
        );


    peerPartyHost =
        createPeerPartyHostState({
            initialPeerStatus: 'connecting',
            render: renderPeerPartyHostState,
            getHostState: () => ({
                mic:
                    typeof audioEnabled === 'undefined'
                        ? true
                        : audioEnabled,
                camera:
                    typeof videoEnabled === 'undefined'
                        ? true
                        : videoEnabled
            })
        });


    peerLive =
        new Peer(
            'djcioko-studio-unic-id'
        );

    attachPeerPartyHostLifecycle(
        peerLive,
        peerPartyHost,
        {
            onOpen: id => {
                console.log(
                    'Studioul este online pe ID-ul: ' +
                    id
                );

                if (
                    typeof showToast ===
                    'function'
                ) {
                    showToast(
                        'Studiu conectat pentru transmisie directă!'
                    );
                }
            },
            onDisconnected: () => {
                try {
                    if (!peerLive.destroyed) {
                        peerLive.reconnect();
                    }
                } catch (error) {
                    console.warn(
                        '[PARTY] Reconectarea PeerJS a eșuat:',
                        error
                    );
                }
            },
            onError: err => {
                console.error(
                    'Erore PeerJS:',
                    err
                );
            }
        }
    );


    /*
     * Data connections:
     * - viewer-presence
     * - guest-request
     */
    peerLive.on(
        'connection',
        connection => {

            if (
                !peerPartyHost.ownsStablePeerId()
            ) {
                try {
                    connection.close();
                } catch (_) {}

                return;
            }

            if (
                connection.label ===
                'viewer-presence'
            ) {
                onlineViewerCounter.attach(
                    connection
                );

                return;
            }


            if (
                connection.label ===
                'guest-request'
            ) {
                peerPartyHost.attachConnection(
                    connection
                );
            }
        }
    );


    /*
     * Media calls:
     * - spectator normal
     * - guest-chat
     */
    peerLive.on(
        'call',
        async call => {

            if (
                !peerPartyHost.ownsStablePeerId()
            ) {
                try {
                    call.close();
                } catch (_) {}

                return;
            }

            const metadata =
                call.metadata || {};


            if (
                metadata.type ===
                'guest-chat'
            ) {
                await waitForMicrophone();

                if (
                    !peerPartyHost.acceptMediaCall(
                        call,
                        broadcastStream
                    )
                ) {
                    console.warn(
                        '[PARTY] Apel respins:',
                        call.peer
                    );
                }

                return;
            }


            /*
             * LIVE NORMAL EXISTENT
             */
            try {
                await waitForMicrophone();

                call.answer(
                    broadcastStream
                );

                console.log(
                    'Un vizitator a accesat transmisiunea live!'
                );

            } catch (error) {
                console.error(
                    'Conexiunea vizitatorului a eșuat:',
                    error
                );
            }
        }
    );


}


/* =========================================================
   START
   ========================================================= */

window.addEventListener(
    'DOMContentLoaded',
    () => {

        ensurePeerPartyHostUi();

        setTimeout(
            () => {
                initStudioBroadcast();
            },
            2000
        );
    }
);
