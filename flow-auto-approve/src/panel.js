const LIST_FIELDS = ['triggerPhrases', 'donePhrases', 'failurePhrases', 'sendPhrases', 'stopPhrases'];
const TEXT_FIELDS = [
  'promptSplit', 'replyText', 'retryText', 'repairTemplate', 'renameCheckTemplate', 'downloadFolder', 'videoEngine', 'videoTemplate', 'renameReplyText', 'namePrefix', 'generateTemplate', 'renameTemplate', 'inputSelector', 'sendSelector',
];
const NUMBER_FIELDS = ['videoBatchSize', 'nameDigits', 'batchSize', 'promptsPerMessage', 'maxExtraReplies', 'questionIdleMs', 'turnEndIdleMs', 'throttleWaitMs'];
const CHECK_FIELDS = ['autoReply', 'repairAfter', 'renameAfter', 'renameCheckAfter', 'videoAfter', 'downloadAfter', 'stripDownloadTimestamp', 'debug'];
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
  ['replyText', 'renameReplyText', 'namePrefix', 'downloadFolder', 'inputSelector', 'sendSelector'].forEach((k) => { s[k] = s[k].trim(); });
  NUMBER_FIELDS.forEach((k) => {
    const n = Number($(k).value);
    s[k] = $(k).value !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : FAA_DEFAULTS[k];
  });
  s.batchSize = Math.max(1, s.batchSize);
  s.turnEndIdleMs = Math.max(1000, s.turnEndIdleMs);
  CHECK_FIELDS.forEach((k) => { s[k] = $(k).checked; });
  ['promptSplit', 'replyText', 'retryText', 'repairTemplate', 'renameCheckTemplate', 'downloadFolder', 'videoEngine', 'videoTemplate', 'renameReplyText', 'generateTemplate', 'renameTemplate'].forEach((k) => {
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

const SPLIT_TEXT = { timecode: 'zaman kodlarından', line: 'satırlardan', blank: 'boş satırlardan' };

function currentPrompts() {
  return faaParsePrompts($('prompts').value, $('promptSplit').value);
}

function renderPromptInfo() {
  const { prompts, mode } = faaSplitPrompts($('prompts').value, $('promptSplit').value);
  const s = readForm();
  let info = `${prompts.length} prompt`;
  if (prompts.length) {
    const batches = Math.ceil(prompts.length / s.batchSize);
    info += ` · ${batches} parti × ${s.batchSize}`;
    if (prompts.length > 1) info += ` · ${SPLIT_TEXT[mode]} ayrıldı`;
  }
  $('promptCount').textContent = info;
  // First and last prompt, so a wrong split is obvious before starting.
  const peek = $('promptPeek');
  peek.textContent = '';
  const shown = prompts.length > 3 ? [0, 1, -1, prompts.length - 1] : prompts.map((_, i) => i);
  shown.forEach((i) => {
    const li = document.createElement('li');
    if (i < 0) {
      li.textContent = '…';
    } else {
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = `${i + 1}.`;
      li.append(num, document.createTextNode(prompts[i]));
      li.title = prompts[i];
    }
    peek.append(li);
  });
  $('nameExample').textContent = `${faaImageName(1, s)}, ${faaImageName(2, s)} … ${faaImageName(Math.max(prompts.length, 3), s)}`;
  $('replyEcho').textContent = s.replyText;
  $('folderEcho').textContent = s.downloadFolder || '';
  $('downloadState').textContent = s.downloadAfter ? 'Açık' : 'Kapalı';
  $('videoRow').hidden = !s.videoAfter;
  $('videoState').textContent = s.videoAfter ? `Açık · ${s.videoEngine}` : 'Kapalı';

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

const FLOW_HOSTS = chrome.runtime.getManifest().host_permissions.map((p) => new URL(p.replace('*', 'x')).hostname);

// Tabs that were already open when the extension was installed or updated
// have no content script yet; inject it instead of asking for a reload.
async function injectInto(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !FLOW_HOSTS.includes(new URL(tab.url).hostname)) return false;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/shared.js', 'src/content.js'] });
    return true;
  } catch {
    return false;
  }
}

async function sendTo(tabId, msg) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // no content script there: not a Flow tab, or opened before the extension
  }
  if (!(await injectInto(tabId))) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

function showError(text) {
  $('error').hidden = !text;
  $('error').textContent = text || '';
}

const NOT_FLOW = 'Etkin sekme Google Flow değil. flow.google.com sekmesine geçip tekrar deneyin; ' +
  'sorun sürerse o sayfayı yenileyin.';

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

async function downloadNow() {
  showError('');
  $('downloadNow').disabled = true;
  $('downloadNow').textContent = '⬇ İndiriliyor…';
  try {
    const res = await sendTo(await targetTabId(), { type: 'faa:download-all' });
    if (!res) return showError(NOT_FLOW);
    if (!res.ok) return showError(res.error);
    reportMessage(res.summary);
  } finally {
    $('downloadNow').disabled = false;
    $('downloadNow').textContent = '⬇ Görselleri indir';
  }
}

async function fetchReport(full) {
  showError('');
  $('reportMsg').hidden = true;
  $('reportText').hidden = true;
  const res = await sendTo(await targetTabId(), { type: 'faa:diagnose', full });
  if (!res?.ok) {
    showError(NOT_FLOW);
    return null;
  }
  // The job as stored, which outlives the tab that ran it (step texts left out).
  const { job: stored } = await chrome.storage.local.get('job');
  if (stored) {
    const { steps, ...rest } = stored;
    res.report.storedJob = { ...rest, steps: steps.map(({ text, ...step }) => ({ ...step, chars: text.length })) };
  }
  return res.report;
}

function reportMessage(text) {
  $('reportMsg').hidden = false;
  $('reportMsg').textContent = text;
}

async function copyReport() {
  const report = await fetchReport(false);
  if (!report) return;
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    reportMessage('Kısa rapor panoya kopyalandı. Sohbete yapıştırabilirsiniz.');
  } catch {
    // Clipboard can be blocked; let the user copy it by hand.
    $('reportText').hidden = false;
    $('reportText').value = text;
    $('reportText').select();
    reportMessage('Panoya kopyalanamadı; aşağıdaki metni seçip kopyalayın.');
  }
}

async function downloadReport() {
  const report = await fetchReport(true);
  if (!report) return;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `flow-tani-raporu-${report.at.replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  reportMessage(`Tam rapor indirildi (${Math.round(blob.size / 1024)} KB). Göndermeden önce içine göz atabilirsiniz.`);
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
    : `Bu adımda yazılan onay: ${job.replies} (Flow sormadan da devam edebilir) · toplam: ${job.totalReplies || 0}` +
      (job.stepSent ? '' : ' · mesaj henüz gönderilmedi');

  let liveText = '';
  if (orphan) {
    liveText = 'Flow sekmesi yenilenmiş; görev bu sekmede çalışmıyor. Devam etmek için Sürdür\'e basın.';
  } else if (status === 'running' && live?.owner) {
    const pr = live.progress;
    const prText = pr ? `Flow'un son bildirdiği parti: ${pr.range[0]}–${pr.range[1]} / ${job.promptCount}. ` : '';
    if (live.throttleSec) liveText = `${prText}Flow limit hatası verdi; kota toparlansın diye ${live.throttleSec} sn bekleniyor, sonra yeniden denetilecek.`;
    else if (live.busy) liveText = `${prText}Flow çalışıyor…`;
    else if (live.asked) liveText = `${prText}Flow onay istiyor; ${live.textIdleSec} sn'dir değişmedi.`;
    else if (job.stepSent) liveText = `${prText}Sayfa ${live.idleSec} sn'dir sakin (adım ${Math.round(settings.turnEndIdleMs / 1000)} sn sonra bitmiş sayılır).`;
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
  document.querySelectorAll('input:not(#file), textarea:not(#prompts), select').forEach((el) => {
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
  $('copyReport').addEventListener('click', copyReport);
  $('downloadNow').addEventListener('click', downloadNow);
  $('downloadReport').addEventListener('click', downloadReport);
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
