// Opens the side panel from the toolbar icon and keeps the badge in sync
// with the job: step progress while running, II when paused, ✓ when done.

importScripts('shared.js');

function enablePanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

async function refreshBadge() {
  const { job } = await chrome.storage.local.get('job');
  let text = '';
  let color = '#1a73e8';
  if (job?.status === 'running') {
    text = `${Math.min(job.stepIndex + 1, job.steps.length)}/${job.steps.length}`;
  } else if (job?.status === 'paused') {
    text = 'II';
    color = '#b45309';
  } else if (job?.status === 'done') {
    text = '✓';
    color = '#188038';
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

chrome.runtime.onInstalled.addListener(() => {
  enablePanelOnClick();
  refreshBadge();
});
chrome.runtime.onStartup.addListener(() => {
  enablePanelOnClick();
  refreshBadge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.job) refreshBadge();
});

// Downloads requested by the content script (it has no downloads API).
const ownNames = new Map(); // url -> filename for our own downloads

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'faa:download') return false;
  ownNames.set(msg.url, msg.filename);
  chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: 'uniquify' })
    .then((id) => waitForDownload(id))
    .then((state) => sendResponse({ ok: state === 'complete', state }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }))
    .finally(() => ownNames.delete(msg.url));
  return true;
});

function waitForDownload(id) {
  return new Promise((resolve) => {
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item || item.state !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(item?.state || 'interrupted');
      }
    };
    const onChanged = (delta) => {
      if (delta.id === id && delta.state) check();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    check();
  });
}

// Flow saves its own downloads as "001_20261010233313.jpg": keep just "001.jpg".
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) {
    const filename = ownNames.get(item.url);
    return suggest(filename ? { filename, conflictAction: 'uniquify' } : undefined);
  }
  const fromFlow = [item.referrer, item.url].some((u) =>
    /^https:\/\/([\w-]+\.)*(flow\.google\.com|labs\.google|googleusercontent\.com|storage\.googleapis\.com)\//.test(u || ''));
  const m = item.filename.match(/^(.*)_\d{14}(\.\w+)$/);
  if (!fromFlow || !m) return suggest();
  chrome.storage.local.get('settings').then(({ settings }) => {
    suggest(faaMergeSettings(settings).stripDownloadTimestamp ? { filename: `${m[1]}${m[2]}` } : undefined);
  });
  return true;
});
