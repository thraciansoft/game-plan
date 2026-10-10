// End-to-end test: loads the unpacked extension into Chromium, serves
// mock-flow.html at a labs.google URL and checks that every "continue?"
// checkpoint is answered automatically.
//
//   node test/e2e.mjs            (uses a local or global `playwright` install)

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const mockHtml = readFileSync(path.join(here, 'mock-flow.html'), 'utf8');

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(path.join(globalRoot, 'noop.js'))('playwright');
  }
}

const { chromium } = loadPlaywright();

const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'faa-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
await context.route('https://labs.google/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mockHtml }));

let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;

// Small timings so the test runs quickly.
await worker.evaluate(() => chrome.storage.local.set({
  settings: { ...FAA_DEFAULTS, delayMs: 300, cooldownMs: 1500 },
  stats: { ...FAA_STATS_DEFAULTS },
}));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function runScenario(ui, extra = '') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`https://labs.google/fx/tools/flow/project/test?ui=${ui}${extra}`);
  await page.waitForFunction(() => window.mockState?.total >= 72 || false, null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => window.mockState);
  await page.screenshot({ path: path.join(tmpdir(), `faa-${ui}.png`) });
  await page.close();
  return { st, errors };
}

for (const ui of ['button', 'dialog', 'chat-textarea', 'chat-ce']) {
  const { st, errors } = await runScenario(ui);
  check(`${ui}: 72 görsel tamamlandı`, st.total === 72, `toplam=${st.total}, soru=${st.questions}`);
  check(`${ui}: dikkat dağıtıcı "Continue" butonuna tıklanmadı`, st.distractorClicks === 0);
  if (ui.startsWith('chat')) {
    check(`${ui}: tam 2 cevap gönderildi`, st.userMessages.length === 2, JSON.stringify(st.userMessages));
  }
  check(`${ui}: sayfa hatası yok`, errors.length === 0, errors.join('; '));
}

// Click-only mode must not type into the chat.
await worker.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) =>
  chrome.storage.local.set({ settings: { ...settings, mode: 'click' } })));
{
  const { st } = await runScenario('chat-textarea', '&target=48');
  check('click modu: sohbete yazmadı', st.userMessages.length === 0 && st.total === 24, `toplam=${st.total}`);
}

// Limit: with maxApprovals=1 only the first checkpoint is answered.
await worker.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) =>
  chrome.storage.local.set({
    settings: { ...settings, mode: 'both', maxApprovals: 1 },
    stats: { ...FAA_STATS_DEFAULTS },
  })));
{
  const { st } = await runScenario('button');
  check('limit: 1 onaydan sonra durdu', st.total === 48, `toplam=${st.total}`);
}

// Disabled: nothing happens.
await worker.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) =>
  chrome.storage.local.set({
    settings: { ...settings, enabled: false, maxApprovals: 0 },
    stats: { ...FAA_STATS_DEFAULTS },
  })));
{
  const { st } = await runScenario('button', '&target=48');
  check('kapalıyken hiçbir şey yapmadı', st.total === 24, `toplam=${st.total}`);
}

// Teach mode: an unknown label ("Sure thing") gets learned by clicking it once.
await worker.evaluate(() => chrome.storage.local.set({
  settings: { ...FAA_DEFAULTS, delayMs: 300, cooldownMs: 1500 },
  stats: { ...FAA_STATS_DEFAULTS },
}));
{
  const page = await context.newPage();
  await page.goto('https://labs.google/fx/tools/flow/project/test?ui=none&startDelay=999999');
  await page.evaluate(() => {
    const card = document.createElement('div');
    card.innerHTML = '<p>Batch finished. Should I continue?</p><button id="sure">Sure thing</button>';
    window.sureClicks = 0;
    card.querySelector('#sure').onclick = () => { window.sureClicks++; card.remove(); };
    document.body.appendChild(card);
  });
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => window.sureClicks);
  await page.bringToFront();
  await worker.evaluate(async () => {
    for (const tab of await chrome.tabs.query({})) {
      chrome.tabs.sendMessage(tab.id, { type: 'faa:pick' }).catch(() => {});
    }
  });
  await page.waitForTimeout(300);
  await page.click('#sure'); // swallowed by teach mode, only records the label
  const learned = await worker.evaluate(() =>
    chrome.storage.local.get('settings').then(({ settings }) => settings.buttonPhrases));
  const afterPick = await page.evaluate(() => window.sureClicks);
  await page.evaluate(() => {
    const card = document.createElement('div');
    card.innerHTML = '<p>48 images done. Should I continue?</p><button id="sure2">Sure thing</button>';
    card.querySelector('#sure2').onclick = () => { window.sureClicks++; card.remove(); };
    document.body.appendChild(card);
  });
  await page.waitForFunction(() => window.sureClicks >= 1, null, { timeout: 8000 }).catch(() => {});
  const after = await page.evaluate(() => window.sureClicks);
  check('öğretme: bilinmeyen buton önceden tıklanmadı', before === 0 && afterPick === 0);
  check('öğretme: etiket kaydedildi', learned.includes('Sure thing'), learned.slice(-2).join(', '));
  check('öğretme: sonraki seferde otomatik tıklandı', after === 1, `tıklama=${after}`);
  await page.close();
}

// Popup renders and reflects stats.
{
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`chrome-extension://${extId}/src/popup.html`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(tmpdir(), 'faa-popup.png'), fullPage: true });
  const count = await page.textContent('#count');
  check('popup açıldı', count !== null, `sayaç=${count}`);
  await page.close();
}

await context.close();
console.log(failures ? `\n${failures} test başarısız` : '\nTüm testler geçti');
process.exit(failures ? 1 : 0);
