// Replays a "Tam rapor" (full diagnostic report) from the side panel: loads the
// captured Flow page with the extension and prints what the extension detects
// there, next to what it detected on the user's machine.
//
//   node test/replay.mjs flow-tani-raporu-....json [--screenshot out.png]

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [reportPath, ...rest] = process.argv.slice(2);
if (!reportPath) {
  console.error('Kullanım: node test/replay.mjs <rapor.json> [--screenshot out.png]');
  process.exit(2);
}
const shotIdx = rest.indexOf('--screenshot');
const screenshot = shotIdx >= 0 ? rest[shotIdx + 1] : null;

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (!report.html) {
  console.error('Bu rapor sayfa HTML\'i içermiyor (Kısa rapor). "Tam rapor" gerekli.');
  process.exit(2);
}

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const globalRoot = execSync('npm root -g').toString().trim();
let playwright;
try {
  playwright = createRequire(import.meta.url)('playwright');
} catch {
  playwright = createRequire(path.join(globalRoot, 'noop.js'))('playwright');
}

const context = await playwright.chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'faa-replay-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
// Only the captured page itself is served; everything else (styles, fonts) is offline.
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith('https://labs.google/') && route.request().resourceType() === 'document') {
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: report.html });
  }
  return route.abort();
});
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
if (report.settings) {
  await worker.evaluate((s) => chrome.storage.local.set({ settings: s }), report.settings);
}

const page = await context.newPage();
await page.goto(report.url.startsWith('https://labs.google/') ? report.url : 'https://labs.google/fx/tools/flow');
await page.waitForTimeout(1500);
const replayed = await worker.evaluate(async () => {
  for (const tab of await chrome.tabs.query({})) {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'faa:diagnose' }).catch(() => null);
    if (res?.ok) return res.report;
  }
  return null;
});
if (screenshot) await page.screenshot({ path: screenshot });

const pick = (d) => d && { tag: d.tag, ariaLabel: d.ariaLabel, placeholder: d.placeholder, text: d.text, rect: d.rect };
console.log('Rapor:', report.at, report.url, `sürüm ${report.version}`);
for (const key of ['input', 'send', 'stop']) {
  console.log(`\n${key}:`);
  console.log('  kullanıcıda :', JSON.stringify(pick(report.detection?.[key])));
  console.log('  yeniden     :', JSON.stringify(pick(replayed?.detection?.[key])));
}
console.log('\nkullanıcıda busy/asked:', report.detection?.busy, report.detection?.asked);
console.log('\nSohbet kutusuna yakın butonlar:');
for (const b of report.buttonsNearInput || []) {
  console.log(`  - ${b.tag} aria="${b.ariaLabel || ''}" text="${b.text || ''}"${b.disabled ? ' (disabled)' : ''}`);
}
console.log('\nEklentinin gördüğü son metin:\n ', report.transcriptTail || '(boş)');
if (report.job) console.log('\nGörev:', JSON.stringify(report.job, null, 2));

await context.close();
