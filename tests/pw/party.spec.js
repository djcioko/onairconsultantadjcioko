const {test, expect} = require('@playwright/test');


async function openFixture(page) {
  await page.goto('/tests/pw/fixture/index.html');
  await page.getByRole('button', {name: 'Deschide camera'}).click();
  await expect(page.locator('[data-host-occupancy]')).toHaveText('1/9');
}


async function requestGuest(page, name, number) {
  await page.getByRole('button', {name: 'Adaugă spectator'}).click();
  const card = page.locator(`[aria-label="Spectator ${number}"]`);
  await card.getByLabel('Numele tău').fill(name);
  await card.getByRole('button', {name: 'Ridică mâna'}).click();
  await expect(page.getByRole('button', {name: `Acceptă ${name}`})).toBeVisible();
  return card;
}


async function acceptAndJoin(page, name, number) {
  const card = await requestGuest(page, name, number);
  await page.getByRole('button', {name: `Acceptă ${name}`}).click();
  await expect(card.getByRole('button', {name: 'Intră în cameră'})).toBeVisible();
  await card.getByRole('button', {name: 'Intră în cameră'}).click();
  await expect(card.locator('[data-party-status]')).toContainText('Ești în camera LIVE');
  return card;
}


test('LIVE-ul public rămâne conectat când camera multiparty se schimbă', async ({page}) => {
  await openFixture(page);
  const publicLive = page.getByRole('region', {name: 'LIVE public existent'});
  await expect(publicLive.locator('[data-public-status]')).toHaveText('Conectat');
  await expect(publicLive.locator('[data-public-viewers]')).toHaveText('3');
  await acceptAndJoin(page, 'Ana', 1);
  await publicLive.getByRole('button', {name: 'Reconectează LIVE public'}).click();
  await expect(publicLive.locator('[data-public-status]')).toHaveText('Conectat');
  await expect(publicLive.locator('[data-public-viewers]')).toHaveText('3');
});


test('un invitat vede gazda și este văzut de gazdă', async ({page}) => {
  await openFixture(page);
  await acceptAndJoin(page, 'Ana', 1);
  await expect(page.locator('[data-host-grid] .party-tile')).toHaveCount(2);
  await expect(page.locator('[data-host-grid]')).toContainText('DJ Cioko');
  await expect(page.locator('[data-host-grid]')).toContainText('Ana');
  await expect(page.locator('[aria-label="Spectator 1"] .party-grid .party-tile')).toHaveCount(2);
});


test('trei invitați se văd simultan în aceeași grilă', async ({page}) => {
  await openFixture(page);
  for (const [index, name] of ['Ana', 'Bea', 'Cezar'].entries()) {
    await acceptAndJoin(page, name, index + 1);
  }
  await expect(page.locator('[data-host-occupancy]')).toHaveText('4/9');
  await expect(page.locator('[data-host-grid] .party-tile')).toHaveCount(4);
  for (const name of ['Ana', 'Bea', 'Cezar']) await expect(page.locator('[data-host-grid]')).toContainText(name);
});


test('reconectarea păstrează identitatea și nu dublează tile-ul', async ({page}) => {
  await openFixture(page);
  const card = await acceptAndJoin(page, 'Ana', 1);
  await card.getByRole('button', {name: 'Reconectează participantul'}).click();
  await expect(card.locator('[data-party-status]')).toContainText('Ești în camera LIVE');
  await expect(page.locator('[data-host-grid] .party-tile')).toHaveCount(2);
  await expect(page.locator('[data-host-grid] .party-name', {hasText: 'Ana'})).toHaveCount(1);
});


test('gazda poate respinge o cerere nominală', async ({page}) => {
  await openFixture(page);
  const card = await requestGuest(page, 'Ana', 1);
  await page.getByRole('button', {name: 'Respinge Ana'}).click();
  await expect(card.locator('[data-party-status]')).toContainText('refuzat');
  await expect(page.locator('[data-host-occupancy]')).toHaveText('1/9');
});


test('limita este 9 total și al nouălea invitat este refuzat', async ({page}) => {
  test.setTimeout(45_000);
  await openFixture(page);
  for (let number = 1; number <= 8; number += 1) {
    await acceptAndJoin(page, `Invitat ${number}`, number);
  }
  await expect(page.locator('[data-host-occupancy]')).toHaveText('9/9');
  const refused = await requestGuest(page, 'Invitat 9', 9).catch(async () => (
    page.locator('[aria-label="Spectator 9"]')
  ));
  await expect(refused.locator('[data-party-status]')).toContainText('maximum 9');
  await expect(page.locator('[data-host-grid] .party-tile')).toHaveCount(9);
});


test('participantul poate ieși și gazda poate elimina individual', async ({page}) => {
  await openFixture(page);
  const ana = await acceptAndJoin(page, 'Ana', 1);
  await acceptAndJoin(page, 'Bea', 2);
  await ana.getByRole('button', {name: 'Ieși din camera LIVE'}).click();
  await expect(page.locator('[data-host-occupancy]')).toHaveText('2/9');
  await page.getByRole('button', {name: 'Elimină Bea'}).click();
  await expect(page.locator('[data-host-occupancy]')).toHaveText('1/9');
  await expect(page.locator('[data-host-grid]')).not.toContainText('Bea');
});


test('gazda închide camera pentru toți cu confirmare', async ({page}) => {
  await openFixture(page);
  const card = await acceptAndJoin(page, 'Ana', 1);
  await page.getByRole('button', {name: 'Închide camera'}).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', {name: 'Da, închide'}).click();
  await expect(page.locator('[data-host-occupancy]')).toHaveText('0/9');
  await expect(card.locator('[data-party-status]')).toContainText('închis camera');
});


test('permisiunile, autoplay și butoanele microfon/cameră sunt recuperabile', async ({page}) => {
  await openFixture(page);
  const denied = await requestGuest(page, 'Ana', 1);
  await page.getByRole('button', {name: 'Acceptă Ana'}).click();
  await denied.getByLabel('Permite camera și microfonul').uncheck();
  await denied.getByRole('button', {name: 'Intră în cameră'}).click();
  await expect(denied.locator('[data-party-status]')).toContainText('Permite accesul');

  const autoplay = await requestGuest(page, 'Bea', 2);
  await page.getByRole('button', {name: 'Acceptă Bea'}).click();
  await autoplay.getByLabel('Permite redarea automată').uncheck();
  await autoplay.getByRole('button', {name: 'Intră în cameră'}).click();
  await expect(autoplay.getByRole('button', {name: 'Pornește redarea sunetului și a imaginii'})).toBeVisible();
  await autoplay.getByRole('button', {name: 'Pornește sau oprește microfonul'}).click();
  await expect(autoplay.getByRole('button', {name: 'Pornește sau oprește microfonul'})).toHaveAttribute('aria-pressed', 'false');
  await autoplay.getByRole('button', {name: 'Pornește sau oprește camera'}).click();
  await expect(autoplay.getByRole('button', {name: 'Pornește sau oprește camera'})).toHaveAttribute('aria-pressed', 'false');
});


test('grila mobilă 360/375/390 nu depășește ecranul și păstrează ținte de 44px', async ({page}) => {
  await page.setViewportSize({width: 900, height: 900});
  await openFixture(page);
  for (const [index, name] of ['Ana', 'Bea', 'Cezar', 'Dora'].entries()) {
    await acceptAndJoin(page, name, index + 1);
  }
  const grid = page.locator('[data-host-grid]');
  await expect(grid.locator('.party-tile')).toHaveCount(5);
  const desktopColumns = await grid.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  expect(desktopColumns).toBe(3);

  for (const width of [360, 375, 390]) {
    await page.setViewportSize({width, height: 800});
    const result = await page.evaluate(() => {
      const node = document.querySelector('[data-host-grid]');
      const buttons = [...document.querySelectorAll('button:not([hidden])')];
      return {
        columns: getComputedStyle(node).gridTemplateColumns.split(' ').length,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        targets: buttons.every(button => {
          const box = button.getBoundingClientRect();
          return (box.width === 0 && box.height === 0) || (box.width >= 44 && box.height >= 44);
        }),
      };
    });
    expect(result).toEqual({columns: 2, overflow: false, targets: true});
  }

  await page.emulateMedia({reducedMotion: 'reduce'});
  await expect(grid.locator('.party-tile').first()).toHaveCSS('transition-duration', '0s');
});
