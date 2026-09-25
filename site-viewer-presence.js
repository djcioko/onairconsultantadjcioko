function createViewerPresenceClient(peer, renderCount) {
    const connection = peer.connect('djcioko-studio-unic-id', {
        label: 'viewer-presence',
        reliable: true
    });
    let watching = false;
    let announced = false;

    function sync() {
        if (!connection.open || watching === announced) return;
        connection.send({ type: watching ? 'watching' : 'stopped' });
        announced = watching;
    }

    connection.on('open', sync);
    connection.on('data', (message) => {
        if (!message || message.type !== 'viewer-count') return;
        if (!Number.isInteger(message.count) || message.count < 0) return;
        renderCount(message.count);
    });
    connection.on('close', () => {
        announced = false;
    });
    connection.on('error', () => {
        announced = false;
    });

    return {
        setWatching(value) {
            watching = Boolean(value);
            sync();
        }
    };
}
