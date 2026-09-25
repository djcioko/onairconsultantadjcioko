// stream.js - Modulul de emisie directă WebRTC (PeerJS) pentru DJCIOKOSTUDIO
let peerLive = null;
let broadcastStream = null;
let onlineViewerCounter = null;

function createViewerPresenceHub(render) {
    const connections = new Set();
    const watchingConnections = new Set();

    function sendCount(connection, count) {
        if (!connection.open) return;
        try {
            connection.send({ type: 'viewer-count', count });
        } catch (error) {
            console.warn('Contorul live nu a putut fi trimis:', error);
        }
    }

    function broadcast() {
        const count = watchingConnections.size;
        render(count);
        connections.forEach((connection) => sendCount(connection, count));
    }

    render(0);

    return {
        get value() {
            return watchingConnections.size;
        },
        attach(connection) {
            if (!connection || connection.label !== 'viewer-presence') return;
            connections.add(connection);

            const remove = () => {
                const changed = watchingConnections.delete(connection);
                connections.delete(connection);
                if (changed) broadcast();
            };

            connection.on('data', (message) => {
                if (!message || typeof message !== 'object') return;
                if (message.type === 'watching' && !watchingConnections.has(connection)) {
                    watchingConnections.add(connection);
                    broadcast();
                } else if (message.type === 'stopped' && watchingConnections.delete(connection)) {
                    broadcast();
                }
            });
            connection.on('close', remove);
            connection.on('error', remove);
            sendCount(connection, watchingConnections.size);
        }
    };
}

function createOnlineViewerCounter(render) {
    const activeConnections = new Set();
    render(0);

    return {
        get value() {
            return activeConnections.size;
        },
        connect() {
            const connectionToken = Symbol('viewer');
            let connected = true;
            activeConnections.add(connectionToken);
            render(activeConnections.size);

            return () => {
                if (!connected) return;
                connected = false;
                activeConnections.delete(connectionToken);
                render(activeConnections.size);
            };
        }
    };
}

function renderOnlineViewerCount(value) {
    const viewerCount = document.getElementById('viewerCount');
    if (viewerCount) viewerCount.textContent = String(value);
}

function attachMicrophoneToBroadcast() {
    if (!broadcastStream || typeof localStream === 'undefined' || !localStream) {
        return false;
    }
    const microphoneTrack = localStream.getAudioTracks()[0];
    if (!microphoneTrack) {
        return false;
    }
    broadcastStream.getAudioTracks().forEach((track) => broadcastStream.removeTrack(track));
    broadcastStream.addTrack(microphoneTrack);
    return true;
}

async function waitForMicrophone() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (attachMicrophoneToBroadcast()) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
}

function initStudioBroadcast() {
    // Verificăm dacă avem deja PeerJS încărcat
    if (typeof Peer === 'undefined') {
        console.error("Biblioteca PeerJS nu este încărcată!");
        return;
    }

    const canvasEl = document.querySelector('canvas');
    if (!canvasEl) {
        console.error("Canvas-ul de emisie nu a fost găsit!");
        return;
    }
    
    // Canvas-ul furnizează video; microfonul este atașat separat din localStream.
    broadcastStream = canvasEl.captureStream(30); // 30 cadre pe secundă
    onlineViewerCounter = createViewerPresenceHub(renderOnlineViewerCount);

    // Inițializăm PeerJS cu un ID unic stabil pentru studioul tău
    peerLive = new Peer('djcioko-studio-unic-id');

    peerLive.on('open', (id) => {
        console.log('Studiul este online pe ID-ul: ' + id);
        if (typeof showToast === 'function') {
            showToast('Studiu conectat pentru transmisie directă!');
        }
    });

    peerLive.on('connection', (connection) => {
        onlineViewerCounter.attach(connection);
    });

    // Când un vizitator intră pe site-ul tău și cere stream-ul, îi răspundem cu stream-ul de pe canvas
    peerLive.on('call', async (call) => {
        try {
            await waitForMicrophone();
            call.answer(broadcastStream);
            console.log('Un vizitator a accesat transmisiunea live!');
        } catch (error) {
            console.error('Conexiunea vizitatorului a eșuat:', error);
        }
    });

    peerLive.on('error', (err) => {
        console.error('Erore PeerJS:', err);
    });
}

// Pornim transmisia automat când se încarcă pagina sau când pornești camera
window.addEventListener('DOMContentLoaded', () => {
    // Așteptăm 2 secunde să se încarce elementele vizuale, apoi inițiem conexiunea
    setTimeout(() => {
        initStudioBroadcast();
    }, 2000);
});
