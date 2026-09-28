const {test, expect} = require('@playwright/test');

const {
  assertDistinctInitialGrants,
  observePartyGrants,
} = require('./support/party-grant-contract.js');
const {
  browserMetrics,
  installRelayOnly,
  serverMetrics,
  validateSamples,
  writeRedactedReport,
} = require('./support/party-metrics.js');


const durationMs = Number(process.env.PARTY_TEST_DURATION_MS || 1_200_000);
const sampleMs = Number(process.env.PARTY_TEST_SAMPLE_MS || 10_000);
if (process.env.PARTY_TEST_PREACTIVATION === '1' && durationMs < 1_200_000) {
  throw new Error('The pre-activation transport gate cannot be shorter than 20 minutes');
}


async function publicTrackSignature(page) {
  return page.evaluate(() => [...document.querySelectorAll(
    '#dj-live-host video[aria-label="Transmisie DJ CIOKO"]',
  )].map(video => ({
    id: video.id,
    tracks: video.srcObject?.getTracks?.().map(track => `${track.kind}:${track.id}`) ?? [],
  })));
}


test('real 1/3/9-client SFU transport stays relay-only and cleans up', async ({browser, request}, testInfo) => {
  test.setTimeout(durationMs + 180_000);
  const startedAt = Date.now();
  const contexts = [];
  const pages = [];
  const grantStreams = [];
  const samples = [];
  const timings = {};

  const createContext = async options => {
    const context = await browser.newContext(options);
    await installRelayOnly(context);
    contexts.push(context);
    return context;
  };

  try {
    const hostContext = await createContext({
      storageState: process.env.PARTY_TEST_OWNER_STORAGE_STATE,
      permissions: ['camera', 'microphone'],
    });
    const host = await hostContext.newPage();
    pages.push(host);
    grantStreams.push(observePartyGrants(host, 'host'));
    await host.goto('/admin/live-studio/');
    await host.getByRole('button', {name: /pornește camera/i}).click();
    await expect(host.locator('#party-open')).toBeEnabled({timeout: 20_000});
    await host.locator('#party-open').click();
    await expect(host.locator('#party-occupancy')).toHaveText('1/9', {timeout: 20_000});

    const guests = [];
    for (let number = 1; number <= 8; number += 1) {
      const context = await createContext({permissions: ['camera', 'microphone']});
      const page = await context.newPage();
      pages.push(page);
      grantStreams.push(observePartyGrants(page, 'guest'));
      await page.goto('/');
      const publicBefore = await publicTrackSignature(page);
      const root = page.locator('[data-party-live-root]');
      await expect(root).toBeVisible({timeout: 20_000});
      const name = `Probe-${number}`;
      await root.getByLabel('Numele tău').fill(name);
      const raisedAt = Date.now();
      await root.getByRole('button', {name: 'Ridică mâna'}).click();
      const row = host.locator('.party-request', {hasText: name});
      await expect(row).toBeVisible({timeout: 10_000});
      await row.getByRole('button', {name: 'Acceptă'}).click();
      await root.getByRole('button', {name: 'Intră în cameră'}).click();
      await expect(root.locator('[data-party-status]')).toContainText('Ești în camera LIVE', {timeout: 20_000});
      timings[`join${number}Ms`] = Date.now() - raisedAt;
      expect(await publicTrackSignature(page)).toEqual(publicBefore);
      guests.push({context, page, root});

      if ([1, 3, 8].includes(number)) {
        await expect(host.locator('#party-grid .party-tile')).toHaveCount(number + 1, {timeout: 20_000});
      }
    }
    await expect(host.locator('#party-occupancy')).toHaveText('9/9');
    assertDistinctInitialGrants(grantStreams.flat(), 8);

    const refusedContext = await createContext({permissions: ['camera', 'microphone']});
    const refused = await refusedContext.newPage();
    pages.push(refused);
    await refused.goto('/');
    const refusedRoot = refused.locator('[data-party-live-root]');
    await refusedRoot.getByLabel('Numele tău').fill('Probe-9');
    await refusedRoot.getByRole('button', {name: 'Ridică mâna'}).click();
    await expect(refusedRoot.locator('[data-party-status]')).toContainText('maximum 9');

    const reconnectStarted = Date.now();
    await guests[0].context.setOffline(true);
    await guests[0].context.setOffline(false);
    await expect(guests[0].root.locator('[data-party-status]')).toContainText('Ești în camera LIVE', {timeout: 10_000});
    timings.reconnectMs = Date.now() - reconnectStarted;
    expect(timings.reconnectMs).toBeLessThan(10_000);
    await expect(host.locator('#party-grid .party-name', {hasText: 'Probe-1'})).toHaveCount(1);

    for (const guest of guests) {
      await expect(guest.root.getByRole('button', {name: 'Pornește sau oprește microfonul'})).toHaveAttribute('aria-pressed', 'true');
      await expect(guest.root.getByRole('button', {name: 'Pornește sau oprește camera'})).toHaveAttribute('aria-pressed', 'true');
      await expect(guest.root.locator('.party-tile')).toHaveCount(9);
    }

    do {
      const atMs = Date.now() - startedAt;
      const server = await serverMetrics(
        request,
        process.env.PARTY_TEST_METRICS_URL,
        process.env.PARTY_TEST_METRICS_TOKEN,
      );
      const clients = [];
      for (let index = 0; index < pages.length - 1; index += 1) {
        clients.push({index, connections: await browserMetrics(pages[index])});
      }
      samples.push({atMs, server, clients});
      if (Date.now() - startedAt < durationMs) await new Promise(resolve => setTimeout(resolve, sampleMs));
    } while (Date.now() - startedAt < durationMs);

    validateSamples(samples, process.env.PARTY_TEST_TURN_HOST);
    const relayConnections = samples.flatMap(sample => sample.clients)
      .flatMap(client => client.connections)
      .filter(connection => connection.connectionState === 'connected');
    expect(relayConnections.length).toBeGreaterThanOrEqual(9);
    expect(relayConnections.every(connection => connection.remoteCandidateType === 'relay')).toBe(true);
    expect(relayConnections.some(connection => connection.turnUrl.includes(process.env.PARTY_TEST_TURN_HOST))).toBe(true);

    const cleanupStarted = Date.now();
    await guests[0].root.getByRole('button', {name: 'Ieși din camera LIVE'}).click();
    await expect(host.locator('#party-occupancy')).toHaveText('8/9', {timeout: 10_000});
    await host.locator('#party-grid .party-tile', {hasText: 'Probe-2'})
      .getByRole('button', {name: /Elimină/}).click();
    await expect(host.locator('#party-occupancy')).toHaveText('7/9', {timeout: 10_000});
    await host.locator('#party-close').click();
    await host.locator('#party-confirm-yes').click();
    await expect(host.locator('#party-occupancy')).toHaveText('0/9', {timeout: 10_000});
    timings.cleanupMs = Date.now() - cleanupStarted;
    expect(timings.cleanupMs).toBeLessThan(10_000);

    const report = {
      schema: 1,
      candidateHost: new URL(process.env.PARTY_TEST_BASE_URL).host,
      turnHost: process.env.PARTY_TEST_TURN_HOST,
      durationMs,
      sampleMs,
      clientCount: 9,
      timings,
      grantSummary: {
        host: grantStreams.flat().filter(value => value.role === 'host').length,
        guest: 8,
      },
      samples,
      cleanup: {complete: true},
    };
    const reportPath = await writeRedactedReport(process.env.PARTY_TEST_REPORT_DIR, report);
    await testInfo.attach('party-transport-report', {path: reportPath, contentType: 'application/json'});
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
  }
});
