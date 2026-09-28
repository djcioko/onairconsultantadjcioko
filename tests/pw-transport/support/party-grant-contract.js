const {createHash} = require('node:crypto');


const GRANT_PATHS = new Set([
  '/api/admin/live/party/open',
  '/api/admin/live/party/host-rejoin',
  '/api/live/party/join',
  '/api/live/party/reconnect',
]);


function opaque(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}


function observePartyGrants(page, role) {
  const grants = [];
  page.on('response', async response => {
    let path;
    try { path = new URL(response.url()).pathname; } catch { return; }
    if (!GRANT_PATHS.has(path) || !response.ok()) return;
    let value;
    try { value = await response.json(); } catch { return; }
    if (typeof value?.identity !== 'string' || typeof value?.token !== 'string') return;
    grants.push({
      role,
      identityHash: opaque(value.identity),
      tokenHash: opaque(value.token),
      generation: Number(value.generation) || 0,
      path,
    });
  });
  return grants;
}


function assertDistinctInitialGrants(records, expected) {
  const initial = records.filter(record => record.path.endsWith('/join'));
  if (initial.length !== expected) {
    throw new Error(`Expected ${expected} guest grants, received ${initial.length}`);
  }
  if (new Set(initial.map(record => record.identityHash)).size !== expected) {
    throw new Error('Guest grant identities are not distinct');
  }
  if (new Set(initial.map(record => record.tokenHash)).size !== expected) {
    throw new Error('Guest grant tokens are not distinct');
  }
}


module.exports = {assertDistinctInitialGrants, observePartyGrants};
