const LIST_FIELDS = ['triggerPhrases', 'sendPhrases', 'stopPhrases'];
const TEXT_FIELDS = [
  'replyText', 'renameReplyText', 'namePrefix', 'generateTemplate', 'renameTemplate', 'inputSelector', 'sendSelector',
];
const NUMBER_FIELDS = ['batchSize', 'promptsPerMessage', 'maxExtraReplies', 'questionIdleMs', 'turnEndIdleMs'];
const CHECK_FIELDS = ['autoReply', 'renameAfter', 'debug'];
const STATUS_TEXT = { running: 'Çalışıyor', paused: 'Duraklatıldı', done: 'Tamamlandı', stopped: 'Durduruldu' };

const $ = (id) => document.getElementById(id);
// Tests open the panel as a normal tab and pass the Flow tab id in the URL.
const fixedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

let settings = faaMergeSettings();
let job = null;
let live; // last status reply from the Flow tab: undefined = not asked yet, null = no answer
let saveTimer = null;
let draftTimer = null;

// ---------------------------------------------------------------- settings

function fillForm(s) {
  LIST_FIELDS.forEach((k) => { $(k).value = (s[k] || []).join('\n'); });
  TEXT_FIELDS.forEach((k) => { $(k).value = s[k] ?? ''; });
  NUMBER_FIELDS.forEach((k) => { $(k).value = s[k]; });
  CHECK_FIELDS.forEach((k) => { $(k).checked = !!s[k]; });
}

function readForm() {
  const s = {};
  LIST_FIELDS.forEach((k) => {
    s[k] = $(k).value.split('\n').map((l) => l.trim()).filter(Boolean);
  });
  TEXT_FIELDS.forEach((k) => { s[k] = $(k).value; });
  ['replyText', 'renameReplyText', 'namePrefix', 'inputSelector', 'sendSelector'].forEach((k) => { s[k] = s[k].trim(); });
  NUMBER_FIELDS.forEach((k) => {
    const n = Number($(k).value);
    s[k] = $(k).value !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : FAA_DEFAULTS[k];
  });
  s.batchSize = Math.max(1, s.batchSize);
  s.turnEndIdleMs = Math.max(1000, s.turnEndIdleMs);
  CHECK_FIELDS.forEach((k) => { s[k] = $(k).checked; });
  ['replyText', 'renameReplyText', 'namePrefix', 'generateTemplate', 'renameTemplate'].forEach((k) => {
    if (!s[k].trim()) s[k] = FAA_DEFAULTS[k];
  });
  return s;
}

async function saveSettings() {
  clearTimeout(saveTimer);
  settings = Object.assign(faaMergeSettings(settings), readForm());
  await chrome.storage.local.set({ settings });
  $('saved').textContent = 'Kaydedildi ✓';
  setTimeout(() => { $('saved').textContent = 'Ayarlar otomatik kaydedilir.'; }, 1500);
}

// --------------------------------------------------------------- prompts

function currentPrompts() {
  return faaParsePrompts($('prompts').value);
}

function renderPromptInfo() {
  const prompts = currentPrompts();
  const s = readForm();
  const lines = $('prompts').value.split('\n').filter((l) => l.trim()).length;
  let info = `${prompts.length} prompt`;
  if (prompts.length) {
    const batches = Math.ceil(prompts.length / s.batchSize);
    info += ` · ${batches} parti × ${s.batchSize}`;
  }
  if (prompts.length === 1 && lines > 1) info += ' (promptların arasına boş satır koydunuz mu?)';
  $('promptCount').textContent = info;
  $('nameExample').textContent = `${s.namePrefix}1, ${s.namePrefix}2…`;
  $('replyEcho').textContent = s.replyText;

  const preview = $('preview');
  preview.textContent = '';
  const steps = faaBuildSteps(prompts, s);
  if (!steps.length) preview.textContent = 'Önce prompt girin.';
  steps.forEach((step, i) => {
    const title = document.createElement('p');
    title.className = 'muted';
    title.textContent = `${i + 1}. mesaj (${step.label}) · beklenen onay: ${step.expected}`;
    const pre = document.createElement('pre');
    pre.textContent = step.text;
    preview.append(title, pre);
  });
}

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => chrome.storage.local.set({ draft: $('prompts').value }), 400);
}

// -------------------------------------------------------------- commands

async function targetTabId() {
  if (fixedTabId) return fixedTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function sendTo(tabId, msg) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null; // no content script there (not a Flow tab, or not reloaded yet)
  }
}

function showError(text) {
  $('error').hidden = !text;
  $('error').textContent = text || '';
}

const NOT_FLOW = 'Bu sekmede eklenti çalışmıyor. Google Flow (labs.google) sekmesine geçin; ' +
  'eklentiyi yeni yüklediyseniz sayfayı yenileyin.';

async function start() {
  showError('');
  const prompts = currentPrompts();
  if (!prompts.length) return showError('Önce prompt girin.');
  if (job?.status === 'running' && live?.owner) return showError('Çalışan bir görev var. Önce durdurun.');
  await saveSettings();
  const tabId = await targetTabId();
  const res = await sendTo(tabId, { type: 'faa:start', prompts, tabId });
  if (!res) return showError(NOT_FLOW);
  if (!res.ok) showError(res.error);
}

async function resume() {
  showError('');
  await saveSettings();
  const tabId = await targetTabId();
  const res = await sendTo(tabId, { type: 'faa:resume', tabId });
  if (!res) return showError(NOT_FLOW);
  if (!res.ok) showError(res.error);
}

// Pause/stop go to the tab running the job; if that tab is gone or was
// reloaded, the stored job is updated directly.
async function control(type) {
  showError('');
  if (!job) return;
  const res = await sendTo(job.tabId, { type });
  if (res?.ok) return;
  if (type === 'faa:next') return showError('Görevi çalıştıran sekme bulunamadı. Önce Flow sekmesinde Sürdür\'e basın.');
  const status = type === 'faa:stop' ? 'stopped' : 'paused';
  const log = [...(job.log || []), { t: Date.now(), msg: STATUS_TEXT[status] }];
  await chrome.storage.local.set({ job: { ...job, status, owner: null, log } });
}

// ---------------------------------------------------------------- render

function fmtTime(t) {
  return new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function render() {
  const status = job?.status;
  // Running according to storage, but the tab that ran it was closed or reloaded.
  const orphan = status === 'running' && live !== undefined && !(live?.owner && live.tabId === job.tabId);
  const chip = $('statusChip');
  chip.className = `chip ${status || ''}`;
  chip.textContent = orphan ? 'Sekme yenilendi' : STATUS_TEXT[status] || 'Hazır';

  const active = status === 'running' || status === 'paused';
  $('start').disabled = status === 'running' && !orphan;
  $('pause').disabled = status !== 'running';
  $('resume').disabled = !(status === 'paused' || status === 'stopped' || orphan);
  $('next').disabled = !active;
  $('stop').disabled = !active;
  $('clear').hidden = !job || (status === 'running' && !orphan);

  $('progress').hidden = !job;
  if (!job) return;
  const total = job.steps.length;
  const idx = Math.min(job.stepIndex, total - 1);
  const step = job.steps[idx];
  $('stepLabel').textContent = status === 'done' ? `Bitti · ${job.promptCount} prompt` : step.label;
  $('stepCount').textContent = `Adım ${Math.min(job.stepIndex + 1, total)}/${total}`;
  const doneSteps = status === 'done' ? total : job.stepIndex;
  $('barFill').style.width = `${Math.round((doneSteps / total) * 100)}%`;
  $('replies').textContent = status === 'done'
    ? `Toplam ${job.totalReplies || 0} onay verildi.`
    : `Bu adımda onay: ${job.replies}/${step.expected} · toplam: ${job.totalReplies || 0}` +
      (job.stepSent ? '' : ' · mesaj henüz gönderilmedi');

  let liveText = '';
  if (orphan) {
    liveText = 'Flow sekmesi yenilenmiş; görev bu sekmede çalışmıyor. Devam etmek için Sürdür\'e basın.';
  } else if (status === 'running' && live?.owner) {
    if (live.busy) liveText = 'Flow çalışıyor…';
    else if (live.asked) liveText = `Flow onay istiyor; ${live.textIdleSec} sn'dir değişmedi.`;
    else if (job.stepSent) liveText = `Sayfa ${live.idleSec} sn'dir sakin (adım ${Math.round(settings.turnEndIdleMs / 1000)} sn sonra bitmiş sayılır).`;
    if (!live.hasInput) liveText = 'Sohbet kutusu bulunamadı!';
  }
  $('live').textContent = liveText;
  $('live').hidden = !liveText;
  $('jobNote').hidden = !job.note;
  $('jobNote').textContent = job.note || '';

  const list = $('log');
  list.textContent = '';
  (job.log || []).slice().reverse().forEach((entry) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = fmtTime(entry.t);
    li.append(time, document.createTextNode(entry.msg));
    list.append(li);
  });
}

function renderStandalone(standalone) {
  $('standaloneCount').textContent = standalone?.count
    ? `Görev dışında ${standalone.count} kez otomatik onay verildi (son: ${fmtTime(standalone.lastAt)}).`
    : '';
}

async function pollLive() {
  const tabId = job?.status === 'running' ? job.tabId : await targetTabId();
  const res = await sendTo(tabId, { type: 'faa:status' });
  live = res ? { ...res, tabId } : null;
  render();
}

// ------------------------------------------------------------------ init

async function init() {
  const res = await chrome.storage.local.get(['settings', 'job', 'draft', 'standalone']);
  settings = faaMergeSettings(res.settings);
  job = res.job || null;
  fillForm(settings);
  $('prompts').value = res.draft || '';
  renderPromptInfo();
  renderStandalone(res.standalone);
  render();

  $('prompts').addEventListener('input', () => {
    renderPromptInfo();
    saveDraft();
  });
  document.querySelectorAll('input:not(#file), textarea:not(#prompts)').forEach((el) => {
    el.addEventListener('input', () => {
      renderPromptInfo();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveSettings, 400);
    });
  });

  $('loadFile').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async () => {
    const file = $('file').files[0];
    if (!file) return;
    $('prompts').value = (await file.text()).replace(/\r\n?/g, '\n');
    $('file').value = '';
    renderPromptInfo();
    saveDraft();
  });

  $('start').addEventListener('click', start);
  $('resume').addEventListener('click', resume);
  $('pause').addEventListener('click', () => control('faa:pause'));
  $('stop').addEventListener('click', () => control('faa:stop'));
  $('next').addEventListener('click', () => control('faa:next'));
  $('clear').addEventListener('click', () => chrome.storage.local.remove('job'));
  $('restore').addEventListener('click', async () => {
    settings = faaMergeSettings();
    fillForm(settings);
    await chrome.storage.local.set({ settings });
    renderPromptInfo();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.job) {
      const before = job;
      job = changes.job.newValue || null;
      if (job?.owner !== before?.owner || job?.status !== before?.status) {
        live = undefined; // the old status reply no longer applies
        pollLive();
      }
      render();
    }
    if (changes.standalone) renderStandalone(changes.standalone.newValue);
  });

  pollLive();
  setInterval(pollLive, 1500);
}

init();
