// stream.js
// DJCIOKOSTUDIO LIVE + GUEST CHAT V1

let peerLive = null;
let broadcastStream = null;
let onlineViewerCounter = null;

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


    peerLive =
        new Peer(
            'djcioko-studio-unic-id'
        );


    peerLive.on(
        'open',
        id => {
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
                handleGuestRequestConnection(
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

            const metadata =
                call.metadata || {};


            if (
                metadata.type ===
                'guest-chat'
            ) {
                await handleGuestMediaCall(
                    call
                );

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


    peerLive.on(
        'error',
        err => {
            console.error(
                'Erore PeerJS:',
                err
            );
        }
    );
}


/* =========================================================
   START
   ========================================================= */

window.addEventListener(
    'DOMContentLoaded',
    () => {

        ensureGuestUi();

        setTimeout(
            () => {
                initStudioBroadcast();
            },
            2000
        );
    }
);
