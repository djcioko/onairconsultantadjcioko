const {mkdir, writeFile} = require('node:fs/promises');
const path = require('node:path');


async function installRelayOnly(context) {
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    const connections = [];
    class RelayOnlyPeerConnection extends Native {
      constructor(configuration = {}) {
        super({...configuration, iceTransportPolicy: 'relay'});
        connections.push(this);
      }
    }
    window.RTCPeerConnection = RelayOnlyPeerConnection;
    window.webkitRTCPeerConnection = RelayOnlyPeerConnection;
    Object.defineProperty(window, '__partyPeerConnections', {value: connections});
  });
}


async function browserMetrics(page) {
  return page.evaluate(async () => {
    const result = [];
    for (const connection of window.__partyPeerConnections ?? []) {
      const stats = await connection.getStats();
      const rows = [...stats.values()];
      const selected = rows.find(row => row.type === 'candidate-pair'
        && (row.selected || (row.nominated && row.state === 'succeeded')));
      const remote = selected && stats.get(selected.remoteCandidateId);
      const local = selected && stats.get(selected.localCandidateId);
      const inbound = rows.filter(row => row.type === 'inbound-rtp' && !row.isRemote);
      const outbound = rows.filter(row => row.type === 'outbound-rtp' && !row.isRemote);
      result.push({
        connectionState: connection.connectionState,
        iceState: connection.iceConnectionState,
        remoteCandidateType: remote?.candidateType ?? '',
        turnUrl: local?.url ?? remote?.url ?? '',
        inboundBytes: inbound.reduce((sum, row) => sum + Number(row.bytesReceived || 0), 0),
        outboundBytes: outbound.reduce((sum, row) => sum + Number(row.bytesSent || 0), 0),
        packetsLost: inbound.reduce((sum, row) => sum + Number(row.packetsLost || 0), 0),
        packetsReceived: inbound.reduce((sum, row) => sum + Number(row.packetsReceived || 0), 0),
        activeDecoders: inbound.filter(row => row.kind === 'video' && Number(row.framesDecoded || 0) > 0).length,
      });
    }
    return result;
  });
}


async function serverMetrics(request, url, token) {
  const response = await request.get(url, {
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
    failOnStatusCode: true,
  });
  const value = await response.json();
  for (const key of ['cpuPercent', 'memoryPercent', 'bandwidthBps']) {
    if (!Number.isFinite(Number(value[key]))) throw new Error(`Metrics provider omitted ${key}`);
  }
  return {
    cpuPercent: Number(value.cpuPercent),
    memoryPercent: Number(value.memoryPercent),
    bandwidthBps: Number(value.bandwidthBps),
  };
}


function validateSamples(samples, turnHost) {
  if (!samples.length) throw new Error('No metrics samples were recorded');
  for (const sample of samples) {
    if (sample.server.cpuPercent >= 80) throw new Error('Candidate server CPU reached 80%');
    if (sample.server.memoryPercent >= 85) throw new Error('Candidate server memory reached 85%');
    for (const client of sample.clients) {
      for (const connection of client.connections) {
        if (connection.remoteCandidateType && connection.remoteCandidateType !== 'relay') {
          throw new Error('A selected ICE pair is not relayed');
        }
        if (connection.turnUrl && !connection.turnUrl.includes(turnHost)) {
          throw new Error('A selected ICE pair used an unexpected TURN host');
        }
      }
    }
  }
  const windowSize = Math.max(1, Math.ceil(60_000 / Math.max(1, samples[1]?.atMs - samples[0]?.atMs || 10_000)));
  for (let start = 0; start + windowSize <= samples.length; start += 1) {
    let lost = 0;
    let received = 0;
    for (const sample of samples.slice(start, start + windowSize)) {
      for (const client of sample.clients) for (const connection of client.connections) {
        lost += connection.packetsLost;
        received += connection.packetsReceived;
      }
    }
    if (received > 0 && lost / (lost + received) >= 0.05) {
      throw new Error('Sustained packet loss reached 5% for 60 seconds');
    }
  }
}


async function writeRedactedReport(directory, report) {
  await mkdir(directory, {recursive: true});
  const destination = path.resolve(directory, 'party-transport-report.json');
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  return destination;
}


module.exports = {
  browserMetrics,
  installRelayOnly,
  serverMetrics,
  validateSamples,
  writeRedactedReport,
};
