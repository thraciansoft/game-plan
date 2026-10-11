// End-to-end test: loads the unpacked extension into Chromium, serves
// mock-flow.html (a stand-in for Flow's agent chat) at a flow.google.com URL and
// runs whole prompt jobs against it.
//
//   node test/e2e.mjs            (uses a local or global `playwright` install)

import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const mockHtml = readFileSync(path.join(here, 'mock-flow.html'), 'utf8');
const FLOW_URL = 'https://flow.google.com/project/test';

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
// A 1×1 PNG stands in for every generated image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const serveMock = (route) => (route.request().url().includes('/media/')
  ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mockHtml }));
await context.route(/^https:\/\/(flow\.google\.com|labs\.google)\//, serveMock);
let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
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
const pad = (n) => String(n).padStart(2, '0');
// Timecoded prompts, one per line, like "[00:04 - 00:07] -> …, 16:9 --ar 16:9".
const makeTimecoded = (n) => Array.from({ length: n }, (_, i) =>
  `[${pad(Math.floor(i / 60))}:${pad(i % 60)} - ${pad(Math.floor((i + 1) / 60))}:${pad((i + 1) % 60)}] -> ` +
  `minimalist vector style, scene ${i + 1}, misty kingdom, 16:9 aspect ratio --ar 16:9`);

// Prompt splitting (pure function, no browser needed).
{
  const shared = vm.createContext({});
  vm.runInContext(readFileSync(path.join(extDir, 'src/shared.js'), 'utf8'), shared);
  const split = (text, mode) => vm.runInContext('(t, m) => faaSplitPrompts(t, m)', shared)(text, mode);
  const timed = makeTimecoded(144);
  const a = split(timed.join('\n'));
  check('ayırma: satır satır zaman kodlu 144 prompt', a.prompts.length === 144 && a.mode === 'timecode' &&
    a.prompts[143].startsWith('[02:23 - 02:24]'), `${a.prompts.length} ${a.mode}`);
  const b = split(timed.join(' '));
  check('ayırma: aynı satırda zaman kodlu 144 prompt', b.prompts.length === 144, String(b.prompts.length));
  const c = split(timed.join('\r\n\u00a0\r\n'));
  check('ayırma: Windows satır sonu + görünmez boşluklu boş satır', c.prompts.length === 144, String(c.prompts.length));
  const d = split('bir\niki satırlı prompt\n\nüç\n\ndört');
  check('ayırma: boş satırla ayrılmış, çok satırlı prompt bir arada', d.mode === 'blank' &&
    JSON.stringify(d.prompts) === JSON.stringify(['bir iki satırlı prompt', 'üç', 'dört']), JSON.stringify(d.prompts));
  const e = split('kedi\nköpek\nkuş');
  check('ayırma: boş satır yoksa her satır bir prompt', e.mode === 'line' && e.prompts.length === 3);
  const merge = vm.runInContext('(x) => faaMergeSettings(x)', shared);
  const old = merge({ namePrefix: 'gorsel', renameTemplate: 'adı {onek}1 … {onek}{toplam}' });
  check('ayarlar: eski "gorsel1" ayarı 001 biçimine geçti', old.namePrefix === '' && !old.renameTemplate.includes('{onek}1'));
  check('ayarlar: yeni kaydedilen önek korunur', merge({ namePrefix: 'img', nameDigits: 3 }).namePrefix === 'img');
  check('ad: 1 → 001, 144 → 144', vm.runInContext('[faaImageName(1, FAA_DEFAULTS), faaImageName(144, FAA_DEFAULTS)].join()', shared) === '001,144');
  const f = split('kedi\nköpek', 'blank');
  check('ayırma: elle "boş satır" seçilince tek prompt', f.prompts.length === 1);
}

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
  images: mockState.images.map(({ n, name }) => ({ n, name })).sort((a, b) => a.n - b.n),
  messages: mockState.messages,
  distractorClicks: mockState.distractorClicks || 0,
}));

function kinds(messages) {
  return messages.map((m) => {
    if (m.includes('video oluştur')) return 'VIDEO';
    if (m.includes('numaralı')) return 'GEN';
    if (m.includes('gözden geçir')) return 'ADKONTROL';
    if (m.includes('kontrol et')) return 'KONTROL';
    if (m.includes('yeniden dene')) return 'R';
    if (/adland/i.test(m)) return 'RENAME';
    if (m === 'Devam et') return 'D';
    if (m === 'Evet, devam et') return 'E';
    return `?${m.slice(0, 20)}`;
  }).join(' ');
}

function checkImages(name, st, n, nameOf = (k) => String(k).padStart(3, '0')) {
  const ordered = st.images.length === n && st.images.every((im, i) => im.n === i + 1);
  const named = st.images.every((im) => im.name === nameOf(im.n));
  check(`${name}: ${n} görsel prompt sırasıyla oluştu`, ordered, `adet=${st.images.length}`);
  check(`${name}: ${nameOf(1)}…${nameOf(n)} olarak adlandırıldı`, named,
    st.images.filter((im) => im.name !== nameOf(im.n)).slice(0, 3).map((im) => `${im.n}:${im.name}`).join(' '));
}

async function jobScenario(name, query, patch, expectedKinds, n = 45, prompts = makePrompts(n), nameOf = undefined) {
  await reset(patch);
  const { page, tabId } = await openFlow(query);
  const res = await startJob(tabId, prompts);
  const job = await waitJob('done');
  await page.waitForTimeout(300);
  const st = await mock(page);
  check(`${name}: görev başladı ve bitti`, res?.ok && job?.status === 'done', job?.note || job?.status);
  check(`${name}: mesaj sırası doğru`, kinds(st.messages) === expectedKinds, kinds(st.messages));
  checkImages(name, st, n, nameOf);
  await page.close();
}

// 45 prompts -> Flow stops after 20 and 40: two "Devam et", then the rename
// step with two "Evet, devam et".
await worker.evaluate(() => {
  globalThis.__faaAsked = [];
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'faa:download') globalThis.__faaAsked.push(msg.filename);
    return false;
  });
});
await jobScenario('textarea + durdur butonu', 'composer=textarea', {}, 'GEN D D KONTROL RENAME E E ADKONTROL');
{
  // The last step downloaded every image as Downloads/Flow/<project>/001.png …
  // Playwright saves downloads under its own names, so check the names the
  // extension asked for, and that every one of those downloads completed.
  const { asked, done } = await worker.evaluate(async () => ({
    asked: globalThis.__faaAsked || [],
    done: (await chrome.downloads.search({ state: 'complete' })).length,
  }));
  const names = [...new Set(asked.filter((f) => f.startsWith('Flow/Mock Flow/')).map((f) => f.split('/').pop()))].sort();
  check('indirme: tamamlanan indirme sayısı', done >= 45, String(done));
  const want = Array.from({ length: 45 }, (_, i) => `${String(i + 1).padStart(3, '0')}.png`);
  check('indirme: 45 görsel Flow/Mock Flow/001.png… olarak indi', JSON.stringify(names) === JSON.stringify(want),
    `${names.length} dosya, ilk: ${names[0]}`);
}
await jobScenario('zengin editör + Enter, durdur butonu yok, sonda da soruyor',
  'composer=ce&stop=0&askAtEnd=1', {}, 'GEN D D KONTROL RENAME E E ADKONTROL');
await jobScenario('tanınmayan soru cümlesi (tur sonu kuralı)', 'composer=textarea&odd=1', {}, 'GEN D D KONTROL RENAME E E ADKONTROL');
await jobScenario('önek + 4 basamak (gorsel0001)', 'composer=textarea', { namePrefix: 'gorsel', nameDigits: 4 },
  'GEN D D KONTROL RENAME E E ADKONTROL', 45, makePrompts(45), (k) => `gorsel${String(k).padStart(4, '0')}`);
await jobScenario('mesaj başına 20 prompt', 'composer=textarea', { promptsPerMessage: 20 }, 'GEN GEN GEN KONTROL RENAME E E ADKONTROL');
// The real Flow: never asks, runs every batch itself and ends with
// "Listedeki 45 sahnenin tamamı … oluşturuldu" (ProseMirror box, arrow_forward button).
await jobScenario('gerçek Flow gibi: sormadan kendi partiliyor', 'composer=pm&self=1', {}, 'GEN KONTROL RENAME ADKONTROL');
// Flow claims "the 40 scenes are all done" with 45 prompts: not finished, so "Devam et".
// Flow moving on without asking: the panel still sees which batch it is on.
{
  await reset();
  const { page, tabId } = await openFlow('composer=pm&self=1&stepMs=60');
  await startJob(tabId, makePrompts(45));
  await page.waitForFunction(() => mockState.images.length >= 25, null, { timeout: 30000 });
  const st = await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'faa:status' }), tabId);
  check('ilerleme: Flow sormadan geçince parti görünüyor', JSON.stringify(st.progress?.range) === '[21,40]',
    JSON.stringify(st.progress));
  await waitJob('done');
  await page.close();
}

// Video step: after the images, every image + its own prompt goes to the chosen model.
{
  await reset({ videoAfter: true, videoEngine: 'Veo 3.1 - Quality', videoBatchSize: 20, downloadAfter: false });
  const { page, tabId } = await openFlow('composer=textarea');
  await startJob(tabId, makePrompts(45));
  const job = await waitJob('done', 90000);
  const st = await page.evaluate(() => ({
    messages: mockState.messages, videos: mockState.videos || [], engine: mockState.videoEngine,
  }));
  check('video: mesaj sırası doğru', job?.status === 'done' &&
    kinds(st.messages) === 'GEN D D KONTROL RENAME E E ADKONTROL VIDEO D D', kinds(st.messages));
  check('video: 45 video, 001_v…045_v, kendi promptlarıyla', st.videos.length === 45 &&
    st.videos.every((v, i) => v.name === `${String(i + 1).padStart(3, '0')}_v` && v.prompt === makePrompts(45)[i]),
    `${st.videos.length} ${st.videos[0]?.name}`);
  check('video: seçilen motor kullanıldı', st.engine === 'Veo 3.1 - Quality', st.engine);
  await page.close();
}

// Switching video on after the job started still adds the video step.
{
  await reset({ videoAfter: false, downloadAfter: false, videoBatchSize: 20 });
  const { page, tabId } = await openFlow('composer=textarea');
  await startJob(tabId, makePrompts(25));
  await page.waitForTimeout(1500);
  await worker.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) =>
    chrome.storage.local.set({ settings: { ...settings, videoAfter: true } })));
  const job = await waitJob('done', 90000);
  const st = await page.evaluate(() => ({ messages: mockState.messages, videos: (mockState.videos || []).length }));
  check('çalışan göreve video eklendi', kinds(st.messages) === 'GEN D KONTROL RENAME E ADKONTROL VIDEO D' &&
    st.videos === 25 && job.steps.length === 5, `${kinds(st.messages)} · ${job?.steps.length} adım`);
  await page.close();
}

// Rate-limit errors: wait, then ask Flow to retry the failed prompts, not just "Devam et".
await jobScenario('istek limiti hatası: yeniden denetiyor', 'composer=textarea&failFirst=25,26,27',
  { throttleWaitMs: 1500 }, 'GEN D R KONTROL RENAME E E ADKONTROL');
// Third real run: an unknown question ("geçmemi ister misiniz?") and the
// prompts echoed back with words like "all", "ready", "done" in them.
await jobScenario('bilinmeyen soru + promptlar sohbette tekrar görünüyor', 'composer=pm&real3=1', {},
  'GEN D D KONTROL RENAME E E ADKONTROL', 45,
  makePrompts(45).map((p) => `${p}, all ready, the work is done, everything complete`));
await jobScenario('Flow eksik bitirip "tamamı" diyor', 'composer=pm&self=1&stopEarlyAt=40', {}, 'GEN D KONTROL RENAME ADKONTROL');

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
  await panel.fill('#prompts', makeTimecoded(144).join('\n'));
  const timedCount = await panel.textContent('#promptCount');
  const lastPeek = await panel.textContent('#promptPeek li:last-child');
  check('panel: zaman kodlu promptlar ayrıldı ve önizlendi', timedCount.startsWith('144 prompt') &&
    timedCount.includes('zaman kodlarından') && lastPeek.startsWith('144.[02:23'), `${timedCount} | ${lastPeek.slice(0, 30)}`);
  await panel.fill('#prompts', text);
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
  check('panel: mesaj sırası doğru', kinds(st.messages) === 'GEN D D KONTROL RENAME E E ADKONTROL', kinds(st.messages));
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

// Old Flow address still works.
{
  await reset();
  const page = await context.newPage();
  await page.goto('https://labs.google/fx/tools/flow/project/test?composer=textarea');
  await page.waitForTimeout(1000);
  const ok = await worker.evaluate(async () => {
    for (const t of await chrome.tabs.query({})) {
      if (await chrome.tabs.sendMessage(t.id, { type: 'faa:ping' }).catch(() => null)) return true;
    }
    return false;
  });
  check('labs.google adresinde de çalışıyor', ok);
  await page.close();
}

await context.close();

// A Flow tab without the content script (opened before the extension was
// installed or updated): the side panel injects it instead of asking for a
// reload. Simulated with a copy of the extension whose content script skips
// flow.google.com, since a headless browser cannot install it later.
{
  const variant = mkdtempSync(path.join(tmpdir(), 'faa-ext-'));
  cpSync(extDir, variant, { recursive: true, filter: (src) => !src.startsWith(path.join(extDir, 'test')) });
  const manifest = JSON.parse(readFileSync(path.join(variant, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches = ['https://labs.google/*'];
  writeFileSync(path.join(variant, 'manifest.json'), JSON.stringify(manifest));

  const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'faa-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${variant}`, `--load-extension=${variant}`],
  });
  await ctx.route(/^https:\/\/flow\.google\.com\//, serveMock);
  const w = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await w.evaluate(() => chrome.storage.local.set({
    settings: { ...FAA_DEFAULTS, questionIdleMs: 300, turnEndIdleMs: 2000 },
  }));
  const page = await ctx.newPage();
  await page.goto(`${FLOW_URL}?composer=textarea`);
  await page.waitForTimeout(1000);
  const panel = await ctx.newPage();
  const panelUrl = `chrome-extension://${new URL(w.url()).host}/src/panel.html`;
  await panel.goto(panelUrl);
  const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ url: 'https://flow.google.com/*' }))[0]?.id);
  const before = await panel.evaluate((id) =>
    chrome.tabs.sendMessage(id, { type: 'faa:ping' }).then(() => true, () => false), tabId);
  check('enjeksiyon: Flow sekmesinde başta eklenti betiği yok', tabId != null && before === false);

  await panel.goto(`${panelUrl}?tabId=${tabId}`);
  await panel.fill('#prompts', makePrompts(25).join('\n\n'));
  await panel.click('#start');
  await panel.waitForFunction(() => document.getElementById('statusChip').textContent === 'Tamamlandı', null,
    { timeout: 60000 }).catch(() => {});
  const st = await mock(page);
  check('enjeksiyon: sayfa yenilenmeden görev çalıştı',
    (await panel.textContent('#statusChip')) === 'Tamamlandı' && kinds(st.messages) === 'GEN D KONTROL RENAME E ADKONTROL',
    `${await panel.textContent('#error')} ${kinds(st.messages)}`);
  checkImages('enjeksiyon', st, 25);

  // Injecting again into a tab that already has the script must not break it.
  const again = await panel.evaluate(async (id) => {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/shared.js', 'src/content.js'] });
    return chrome.tabs.sendMessage(id, { type: 'faa:ping' }).then((r) => !!r?.ok, () => false);
  }, tabId);
  check('enjeksiyon: ikinci kez enjekte etmek sorunsuz', again);
  await ctx.close();
}

console.log(failures ? `\n${failures} test başarısız` : '\nTüm testler geçti');
process.exit(failures ? 1 : 0);
