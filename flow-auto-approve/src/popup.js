const LIST_FIELDS = ['buttonPhrases', 'triggerPhrases', 'excludePhrases', 'sendPhrases'];
const TEXT_FIELDS = ['replyText', 'approveSelector', 'inputSelector', 'sendSelector'];
const NUMBER_FIELDS = ['delayMs', 'cooldownMs', 'maxApprovals'];
const CHECK_FIELDS = ['enabled', 'requireTrigger', 'debug'];

const $ = (id) => document.getElementById(id);
let saveTimer = null;

function fillForm(s) {
  LIST_FIELDS.forEach((k) => { $(k).value = (s[k] || []).join('\n'); });
  TEXT_FIELDS.forEach((k) => { $(k).value = s[k] || ''; });
  NUMBER_FIELDS.forEach((k) => { $(k).value = s[k]; });
  CHECK_FIELDS.forEach((k) => { $(k).checked = !!s[k]; });
  document.querySelectorAll('input[name="mode"]').forEach((r) => { r.checked = r.value === s.mode; });
}

function readForm() {
  const s = {};
  LIST_FIELDS.forEach((k) => {
    s[k] = $(k).value.split('\n').map((l) => l.trim()).filter(Boolean);
  });
  TEXT_FIELDS.forEach((k) => { s[k] = $(k).value.trim(); });
  NUMBER_FIELDS.forEach((k) => {
    const n = Number($(k).value);
    s[k] = Number.isFinite(n) && n >= 0 ? Math.round(n) : FAA_DEFAULTS[k];
  });
  s.cooldownMs = Math.max(1000, s.cooldownMs);
  CHECK_FIELDS.forEach((k) => { s[k] = $(k).checked; });
  s.mode = document.querySelector('input[name="mode"]:checked')?.value || FAA_DEFAULTS.mode;
  if (!s.replyText) s.replyText = FAA_DEFAULTS.replyText;
  return s;
}

function renderStats(stats) {
  const st = Object.assign({}, FAA_STATS_DEFAULTS, stats);
  $('count').textContent = st.count;
  $('lastAction').textContent = st.lastAction
    ? `Son: ${st.lastAction} · ${new Date(st.lastActionAt).toLocaleTimeString('tr-TR')}`
    : 'Henüz otomatik onay yapılmadı.';
  $('lastNote').hidden = !st.lastNote;
  $('lastNote').textContent = st.lastNote;
}

async function save() {
  const current = faaMergeSettings((await chrome.storage.local.get('settings')).settings);
  await chrome.storage.local.set({ settings: Object.assign(current, readForm()) });
  $('saved').textContent = 'Kaydedildi ✓';
  setTimeout(() => { $('saved').textContent = 'Değişiklikler otomatik kaydedilir.'; }, 1500);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

async function startPick() {
  const msg = $('pickMsg');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'faa:pick' });
    window.close(); // let the user click on the page
  } catch {
    msg.hidden = false;
    msg.textContent = 'Bu sekmede eklenti çalışmıyor. Google Flow (labs.google) sekmesinde açın; ' +
      'eklentiyi yeni yüklediyseniz sayfayı yenileyin.';
  }
}

async function init() {
  const res = await chrome.storage.local.get(['settings', 'stats']);
  fillForm(faaMergeSettings(res.settings));
  renderStats(res.stats);

  document.body.addEventListener('input', scheduleSave);
  document.body.addEventListener('change', scheduleSave);

  $('reset').addEventListener('click', () => {
    chrome.storage.local.set({ stats: Object.assign({}, FAA_STATS_DEFAULTS) });
  });
  $('restore').addEventListener('click', async () => {
    fillForm(FAA_DEFAULTS);
    await chrome.storage.local.set({ settings: Object.assign({}, FAA_DEFAULTS) });
  });
  $('pick').addEventListener('click', startPick);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.stats) renderStats(changes.stats.newValue);
    // The page's "teach" mode adds phrases; reflect them unless the user is typing.
    if (changes.settings && !document.activeElement?.matches('input, textarea')) {
      fillForm(faaMergeSettings(changes.settings.newValue));
    }
  });
}

init();
