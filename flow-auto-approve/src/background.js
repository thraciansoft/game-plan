// Keeps the toolbar badge in sync: approval count, OFF, or MAX when the
// configured limit is reached.

importScripts('defaults.js');

async function refreshBadge() {
  const res = await chrome.storage.local.get(['settings', 'stats']);
  const settings = faaMergeSettings(res.settings);
  const count = res.stats?.count || 0;
  let text = '';
  let color = '#1a73e8';
  if (!settings.enabled) {
    text = 'OFF';
    color = '#6b7280';
  } else if (settings.maxApprovals > 0 && count >= settings.maxApprovals) {
    text = 'MAX';
    color = '#b45309';
  } else if (count) {
    text = count > 999 ? '999+' : String(count);
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') refreshBadge();
});
