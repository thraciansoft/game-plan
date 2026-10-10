// End-to-end test: loads the unpacked extension into Chromium, serves
// mock-flow.html (a stand-in for Flow's agent chat) at a labs.google URL and
// runs whole prompt jobs against it.
//
//   node test/e2e.mjs            (uses a local or global `playwright` install)

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const mockHtml = readFileSync(path.join(here, 'mock-flow.html'), 'utf8');
const FLOW_URL = 'https://labs.google/fx/tools/flow/project/test';

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
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// Fast timings so a whole job takes seconds instead of minutes.
async function reset(patch = {}) {
  await worker.evaluate((p) => chrome.storage.local.clear().then(() => chrome.storage.local.set({
    settings: { ...FAA_DEFAULTS, questionIdleMs: 300, turnEndIdleMs: 2000, ...p },
  })), patch);
}

const makePrompts = (n) => Array.from({ length: n }, (_, i) => `kırmızı tilki, sahne ${i + 1}, sinematik ışık`);

async function openFlow(query) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('page error:', String(e)));
  await page.goto(`${FLOW_URL}?${query}`);
  await page.waitForTimeout(3500); // the extension ignores what renders during page load
  const tabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const ids = [];
    for (const t of tabs) {
      if (await chrome.tabs.sendMessage(t.id, { type: 'faa:ping' }).catch(() => null)) ids.push(t.id);
    }
    return Math.max(...ids);
  });
  return { page, tabId };
}

const startJob = (tabId, prompts) =>
  worker.evaluate(([id, p]) => chrome.tabs.sendMessage(id, { type: 'faa:start', prompts: p, tabId: id }), [tabId, prompts]);

async function waitJob(status, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) {
    const job = await worker.evaluate(() => chrome.storage.local.get('job').then((r) => r.job));
    if (job?.status === status || Date.now() > end) return job;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const mock = (page) => page.evaluate(() => ({
  images: mockState.images.map(({ n, name }) => ({ n, name })),
  messages: mockState.messages,
  distractorClicks: mockState.distractorClicks || 0,
}));

function kinds(messages) {
  return messages.map((m) => {
    if (m.includes('numaralı')) return 'GEN';
    if (/adland/i.test(m)) return 'RENAME';
    if (m === 'Devam et') return 'D';
    if (m === 'Evet, devam et') return 'E';
    return `?${m.slice(0, 20)}`;
  }).join(' ');
}

function checkImages(name, st, n) {
  const ordered = st.images.length === n && st.images.every((im, i) => im.n === i + 1);
  const named = st.images.every((im) => im.name === `gorsel${im.n}`);
  check(`${name}: ${n} görsel prompt sırasıyla oluştu`, ordered, `adet=${st.images.length}`);
  check(`${name}: gorsel1…gorsel${n} olarak adlandırıldı`, named,
    st.images.filter((im) => im.name !== `gorsel${im.n}`).slice(0, 3).map((im) => `${im.n}:${im.name}`).join(' '));
}

async function jobScenario(name, query, patch, expectedKinds, n = 45) {
  await reset(patch);
  const { page, tabId } = await openFlow(query);
  const res = await startJob(tabId, makePrompts(n));
  const job = await waitJob('done');
  await page.waitForTimeout(300);
  const st = await mock(page);
  check(`${name}: görev başladı ve bitti`, res?.ok && job?.status === 'done', job?.note || job?.status);
  check(`${name}: mesaj sırası doğru`, kinds(st.messages) === expectedKinds, kinds(st.messages));
  checkImages(name, st, n);
  await page.close();
}

// 45 prompts -> Flow stops after 20 and 40: two "Devam et", then the rename
// step with two "Evet, devam et".
await jobScenario('textarea + durdur butonu', 'composer=textarea', {}, 'GEN D D RENAME E E');
await jobScenario('zengin editör + Enter, durdur butonu yok, sonda da soruyor',
  'composer=ce&stop=0&askAtEnd=1', {}, 'GEN D D D RENAME E E');
await jobScenario('tanınmayan soru cümlesi (tur sonu kuralı)', 'composer=textarea&odd=1', {}, 'GEN D D RENAME E E');
await jobScenario('mesaj başına 20 prompt', 'composer=textarea', { promptsPerMessage: 20 }, 'GEN GEN GEN RENAME E E');

// Without a job: answers "Devam edeyim mi?" on its own, but only when enabled.
{
  await reset({ autoReply: true });
  const { page } = await openFlow('composer=textarea');
  const list = makePrompts(45).map((p, i) => `${i + 1}. ${p}`).join('\n\n');
  await page.evaluate((t) => mockUserSays(t), list);
  await page.waitForFunction(() => mockState.images.length === 45 && !mockState.busy, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(500);
  const st = await mock(page);
  check('görev yokken: soruları "Devam et" ile cevapladı', st.images.length === 45 && st.messages.length === 3 &&
    st.messages.slice(1).every((m) => m === 'Devam et'), `görsel=${st.images.length}, mesaj=${st.messages.length}`);
  check('görev yokken: uzaktaki "Stop" butonu meşgul sayılmadı/tıklanmadı', st.distractorClicks === 0);
  await page.close();

  await reset({ autoReply: false });
  const { page: page2 } = await openFlow('composer=textarea');
  await page2.evaluate((t) => mockUserSays(t), list);
  await page2.waitForTimeout(5000);
  const st2 = await mock(page2);
  check('otomatik cevap kapalıyken: hiçbir şey yazmadı', st2.messages.length === 1 && st2.images.length === 20,
    `mesaj=${st2.messages.length}`);
  await page2.close();
}

// Side panel: paste prompts, start, pause, resume.
{
  await reset();
  const { page, tabId } = await openFlow('composer=textarea');
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extId}/src/panel.html?tabId=${tabId}`);
  const text = makePrompts(45).map((p, i) => (i === 3 ? `${p}\nikinci satır` : p)).join('\n\n');
  await panel.fill('#prompts', text);
  const count = await panel.textContent('#promptCount');
  check('panel: promptlar boş satırdan ayrıldı', count.startsWith('45 prompt'), count);
  await panel.click('#start');

  await page.waitForFunction(() => mockState.messages.length >= 2, null, { timeout: 30000 });
  await panel.click('#pause');
  await page.waitForFunction(() => mockState.images.length >= 40 && !mockState.busy, null, { timeout: 30000 });
  await page.waitForTimeout(4000);
  const paused = await mock(page);
  check('panel: duraklatınca cevap yazmadı', paused.messages.length === 2, kinds(paused.messages));
  check('panel: durum "Duraklatıldı"', (await panel.textContent('#statusChip')) === 'Duraklatıldı');

  await panel.click('#resume');
  const job = await waitJob('done');
  await panel.waitForTimeout(1000);
  const st = await mock(page);
  check('panel: sürdürünce görev tamamlandı', job?.status === 'done', job?.note);
  check('panel: mesaj sırası doğru', kinds(st.messages) === 'GEN D D RENAME E E', kinds(st.messages));
  checkImages('panel', st, 45);
  check('panel: durum "Tamamlandı"', (await panel.textContent('#statusChip')) === 'Tamamlandı');

  const [download] = await Promise.all([panel.waitForEvent('download'), panel.click('#downloadReport')]);
  const full = JSON.parse(readFileSync(await download.path(), 'utf8'));
  check('panel: tam rapor indirildi', !!full.html && full.detection?.input?.tag === 'textarea');
  await panel.click('#copyReport');
  await panel.waitForTimeout(300);
  check('panel: kısa rapor hazırlandı', await panel.isVisible('#reportMsg'), await panel.textContent('#reportMsg'));
  await panel.screenshot({ path: path.join(tmpdir(), 'faa-panel.png'), fullPage: true });
  await panel.close();
  await page.close();
}

// Diagnostic report: finds the chat box and buttons, strips scripts and media
// links, and the replay script detects the same things in the snapshot.
{
  await reset({ autoReply: false });
  const { page, tabId } = await openFlow('composer=textarea');
  await page.evaluate((t) => mockUserSays(t), makePrompts(25).map((p, i) => `${i + 1}. ${p}`).join('\n\n'));
  await page.waitForFunction(() => mockState.images.length === 20 && !mockState.busy, null, { timeout: 30000 });
  await page.evaluate(() => {
    const img = document.createElement('img');
    img.src = 'https://lh3.googleusercontent.com/gizli-imzali-link';
    document.body.appendChild(img);
  });
  await page.waitForTimeout(500);
  const report = await worker.evaluate((id) =>
    chrome.tabs.sendMessage(id, { type: 'faa:diagnose', full: true }).then((r) => r.report), tabId);
  check('rapor: sohbet kutusu bulundu', report.detection.input?.tag === 'textarea');
  check('rapor: gönder butonu bulundu', report.detection.send?.ariaLabel === 'Send message');
  check('rapor: "Devam edeyim mi?" algılandı', report.detection.asked === true, report.transcriptTail.slice(-60));
  check('rapor: betikler ve görsel linkleri çıkarıldı',
    !/<script/i.test(report.html) && !report.html.includes('gizli-imzali-link'));
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'faa-report-')), 'rapor.json');
  writeFileSync(file, JSON.stringify(report));
  const out = execFileSync('node', [path.join(here, 'replay.mjs'), file], { encoding: 'utf8' });
  check('replay: anlık görüntüde aynı sohbet kutusu bulundu', out.includes('yeniden     : {"tag":"textarea"'), out.split('\n')[3]);
  await page.close();
}

await context.close();
console.log(failures ? `\n${failures} test başarısız` : '\nTüm testler geçti');
process.exit(failures ? 1 : 0);
