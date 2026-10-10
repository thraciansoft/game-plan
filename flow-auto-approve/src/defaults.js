// Shared defaults and text helpers. Loaded by the content script, the popup
// and the service worker (as a classic script), so it only defines globals.

const FAA_DEFAULTS = {
  enabled: true,
  // 'click'   -> only click an approve button
  // 'message' -> only type a reply into the chat and send it
  // 'both'    -> prefer the button, fall back to a chat reply
  mode: 'both',
  // Labels of buttons that mean "yes, keep going" (whole-word, case/diacritic-insensitive).
  buttonPhrases: [
    'Devam', 'Devam et', 'Devam edin', 'Onayla', 'Onaylıyorum', 'Evet',
    'Continue', 'Approve', 'Confirm', 'Yes', 'Proceed', 'Keep going', 'Generate more',
  ],
  // Text that must appear near the button (or in a new chat message) for the
  // extension to act. Substring match, case/diacritic-insensitive.
  // Kept question-shaped on purpose: in chat mode a match makes the extension
  // send a reply, so generic words like "continue" would cause stray messages.
  triggerPhrases: [
    'devam etmemi', 'devam edeyim mi', 'devam edelim mi', 'devam etmek ister', 'devam etmek istiyor',
    'devam etmeli miyim', 'devam edilsin mi', 'onaylıyor musun', 'onay ver', 'onayınız',
    'onayın', 'onay gerek',
    'should i continue', 'shall i continue', 'would you like me to continue',
    'do you want me to continue', 'want to continue', 'like to continue',
    'devam?', 'continue generating?', 'keep going?', 'continue?', 'proceed?', 'more?',
    'your approval', 'approval needed', 'approval required', 'confirm to continue',
  ],
  // Buttons whose label contains any of these are never clicked.
  excludePhrases: [
    'Durdur', 'İptal', 'Hayır', 'Vazgeç', 'Stop', 'Cancel', 'No', "Don't", 'Do not', 'Reject', 'Deny',
  ],
  // When true, a matching button is only clicked if a trigger phrase is
  // visible in the surrounding container (e.g. the dialog or chat bubble).
  requireTrigger: true,
  replyText: 'Evet, devam et',
  // Labels / icon names of the chat "send" button.
  sendPhrases: ['send', 'gönder', 'submit', 'arrow_upward', 'arrow_forward', 'send_message'],
  delayMs: 1500, // wait before acting (lets the UI finish rendering/streaming)
  cooldownMs: 6000, // minimum time between two automatic approvals
  maxApprovals: 0, // 0 = unlimited; otherwise pause after this many approvals
  // Optional CSS selectors for when text matching is not enough.
  approveSelector: '',
  inputSelector: '',
  sendSelector: '',
  debug: false,
};

const FAA_STATS_DEFAULTS = {
  count: 0,
  lastAction: '',
  lastActionAt: 0,
  lastNote: '',
};

function faaNormalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function faaEscapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word matcher for an already-normalized haystack: "no" matches "No" and
// "no thanks" but not "not" or "Nota". Returns null for an empty phrase.
function faaWordRegExp(phrase) {
  const p = faaNormalize(phrase);
  if (!p) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${faaEscapeRegExp(p)}(?![\\p{L}\\p{N}_])`, 'u');
}

function faaMergeSettings(stored) {
  return Object.assign({}, FAA_DEFAULTS, stored || {});
}
