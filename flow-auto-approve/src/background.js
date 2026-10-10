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
