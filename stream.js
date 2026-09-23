// stream.js - Modulul de emisie directă WebRTC (PeerJS) pentru DJCIOKOSTUDIO
let peerLive = null;
let broadcastStream = null;

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
    
    // Capturăm stream-ul video și audio de pe canvas-ul tău
    broadcastStream = canvasEl.captureStream(30); // 30 cadre pe secundă

    // Inițializăm PeerJS cu un ID unic stabil pentru studioul tău
    peerLive = new Peer('djcioko-studio-unic-id');

    peerLive.on('open', (id) => {
        console.log('Studiul este online pe ID-ul: ' + id);
        if (typeof showToast === 'function') {
            showToast('Studiu conectat pentru transmisie directă!');
        }
    });

    // Când un vizitator intră pe site-ul tău și cere stream-ul, îi răspundem cu stream-ul de pe canvas
    peerLive.on('call', (call) => {
        call.answer(broadcastStream);
        console.log('Un vizitator a accesat transmisiunea live!');
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
