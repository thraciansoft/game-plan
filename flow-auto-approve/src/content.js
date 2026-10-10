// Flow Oto-Onay content script.
//
// Watches the Google Flow page for the "should I continue?" checkpoint that
// appears after every batch of generations and answers it automatically,
// either by clicking the approve button or by typing a reply into the chat.

(() => {
  if (window.__faaLoaded) return;
  window.__faaLoaded = true;

  const TAG = '[Flow Oto-Onay]';
  const CLICKABLE = [
    'button', '[role="button"]', 'input[type="button"]', 'input[type="submit"]',
    '[role="menuitem"]', '[role="option"]',
  ].join(',');
  const INPUTS = [
    'textarea', '[contenteditable="true"]', '[contenteditable=""]',
    '[contenteditable="plaintext-only"]', '[role="textbox"]', 'input[type="text"]', 'input:not([type])',
  ].join(',');
  const EDITABLE = 'textarea, input, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  const STARTUP_GRACE_MS = 3000; // ignore chat history rendered while the page loads
  const TRIGGER_TTL_MS = 60000;
  const MAX_MESSAGE_CHARS = 1500; // bigger additions are re-rendered history, not a new message
  const MIN_SCAN_GAP_MS = 500;
  const NEAR_PX = 250; // max on-screen distance between the question and its button

  let settings = faaMergeSettings();
  let stats = Object.assign({}, FAA_STATS_DEFAULTS);
  let compiled = compile(settings);
  let acting = false;
  let picking = false;
  let lastActionAt = 0;
  let lastScanAt = 0;
  let scanTimer = null;
  let pendingTrigger = null; // { text, node, at } from a newly rendered chat message
  let lastNote = '';
  let limitAnnounced = false;
  const startedAt = Date.now();
  const clicked = new Set(); // buttons already clicked while they stay on screen

  let observer = null;
  let intervalId = null;

  const log = (...args) => settings.debug && console.log(TAG, ...args);

  function alive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function shutdown() {
    observer?.disconnect();
    clearInterval(intervalId);
  }

  function compile(s) {
    const words = (list) => (list || []).map(faaWordRegExp).filter(Boolean);
    return {
      button: words(s.buttonPhrases),
      exclude: words(s.excludePhrases),
      send: words(s.sendPhrases),
      trigger: (s.triggerPhrases || []).map(faaNormalize).filter(Boolean),
      reply: faaNormalize(s.replyText),
    };
  }

  // ---------------------------------------------------------------- storage

  chrome.storage.local.get(['settings', 'stats'], (res) => {
    settings = faaMergeSettings(res.settings);
    stats = Object.assign({}, FAA_STATS_DEFAULTS, res.stats);
    compiled = compile(settings);
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = faaMergeSettings(changes.settings.newValue);
      compiled = compile(settings);
    }
    if (changes.stats) {
      stats = Object.assign({}, FAA_STATS_DEFAULTS, changes.stats.newValue);
      if (stats.count === 0) limitAnnounced = false;
    }
    scheduleScan();
  });

  async function updateStats(patch) {
    if (!alive()) return;
    const res = await chrome.storage.local.get('stats');
    stats = Object.assign({}, FAA_STATS_DEFAULTS, res.stats, patch(res.stats || FAA_STATS_DEFAULTS));
    await chrome.storage.local.set({ stats });
  }

  function note(text) {
    if (text === lastNote) return;
    lastNote = text;
    log(text);
    updateStats(() => ({ lastNote: text })).catch(() => {});
  }

  async function record(action) {
    lastActionAt = Date.now();
    await updateStats((s) => ({
      count: (s.count || 0) + 1,
      lastAction: action,
      lastActionAt,
      lastNote: '',
    }));
    lastNote = '';
    toast(`✓ ${action} (#${stats.count})`);
    log(action);
  }

  // ------------------------------------------------------------- DOM helpers

  function ownUi(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return !!el?.closest?.('#faa-host');
  }

  function insideEditable(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return !!el?.closest?.(EDITABLE);
  }

  // querySelectorAll that also looks inside open shadow roots.
  function deepQueryAll(selector, root = document) {
    let out = [];
    try {
      out = Array.from(root.querySelectorAll(selector));
    } catch {
      return out; // invalid user-supplied selector
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) out = out.concat(deepQueryAll(selector, el.shadowRoot));
    }
    return out;
  }

  // Text of a subtree with separate text nodes joined by spaces, so an icon
  // ligature like "arrow_forward" does not glue onto the word next to it.
  function textOf(node, limit = 4000) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
    const out = [];
    let len = 0;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const tag = n.parentElement?.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      const t = n.data.trim();
      if (!t) continue;
      out.push(t);
      len += t.length + 1;
      if (len > limit) break;
    }
    return out.join(' ');
  }

  function labelOf(el) {
    const bits = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.tagName === 'INPUT' ? el.value : '',
      textOf(el, 200),
    ];
    return bits.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function short(text, n = 40) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  }

  function isVisible(el) {
    if (!el.isConnected || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    return !el.closest('[aria-hidden="true"], [inert]');
  }

  function isEnabled(el) {
    return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => Math.max(0, Math.round(ms * (0.85 + Math.random() * 0.3)));

  function clickEl(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', ptr));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', ptr));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.click();
  }

  // ------------------------------------------------------- approve button

  function matchesButton(el) {
    const label = faaNormalize(labelOf(el));
    if (!label || label.length > 80) return false;
    if (compiled.exclude.some((re) => re.test(label))) return false;
    return compiled.button.some((re) => re.test(label));
  }

  function hasTrigger(normalizedText) {
    return compiled.trigger.some((p) => normalizedText.includes(p));
  }

  function gap(a, b) {
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return Math.hypot(dx, dy);
  }

  // Looks for a trigger phrase in the containers around the button (dialog,
  // chat bubble, card), ignoring the button's own label. The element holding
  // the phrase must also sit next to the button on screen, so an unrelated
  // "Continue" elsewhere on the page is not clicked.
  function triggerNear(el) {
    const own = faaNormalize(textOf(el, 200));
    const textAround = (node) => {
      const text = faaNormalize(textOf(node, 3000));
      return own && node.contains(el) ? text.replace(own, ' ') : text;
    };
    // Deepest elements whose text contains a trigger phrase.
    const holders = (node, out) => {
      const kids = Array.from(node.children).filter((c) => c !== el && hasTrigger(textAround(c)));
      if (!kids.length) out.push(node);
      kids.forEach((c) => holders(c, out));
      return out;
    };
    const btnRect = el.getBoundingClientRect();
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      if (textOf(node, 3000).length > 3000) break; // reached a page-sized container
      if (!hasTrigger(textAround(node))) continue;
      const near = holders(node, []).some((h) => {
        const r = h.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && gap(r, btnRect) <= NEAR_PX;
      });
      if (near) return true;
    }
    return false;
  }

  function contextOf(el) {
    const own = faaNormalize(textOf(el, 200));
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const text = faaNormalize(textOf(node, 400)).replace(own, ' ').trim();
      if (text.length > 15) return short(text, 160);
    }
    return '';
  }

  function pruneClicked() {
    for (const el of clicked) {
      if (!isVisible(el)) clicked.delete(el);
    }
  }

  function findApproveButton() {
    pruneClicked();
    const usable = (el) => !clicked.has(el) && !ownUi(el) && isVisible(el) && isEnabled(el);

    if (settings.approveSelector) {
      const el = deepQueryAll(settings.approveSelector).find(usable);
      if (el) return el; // an explicit selector is trusted, no trigger needed
    }

    let rejected = null;
    for (const el of deepQueryAll(CLICKABLE)) {
      if (!matchesButton(el) || !usable(el)) continue;
      if (settings.requireTrigger && !triggerNear(el)) {
        rejected = rejected || el;
        continue;
      }
      return el;
    }
    if (rejected) {
      note(`Aday buton görüldü ("${short(labelOf(rejected))}") ama yakınında tetik ifadesi yok; tıklanmadı.`);
    }
    return null;
  }

  // ---------------------------------------------------------- chat reply

  function ancestors(node) {
    const list = [];
    for (let n = node; n; n = n.parentNode || n.host) list.push(n);
    return list;
  }

  // Depth of the lowest common ancestor: bigger means "closer together".
  function closeness(a, b) {
    if (!a || !b) return 0;
    const set = new Set(ancestors(a));
    const chain = ancestors(b);
    const lca = chain.find((n) => set.has(n));
    return lca ? ancestors(lca).length : 0;
  }

  function findChatInput(near) {
    if (settings.inputSelector) {
      return deepQueryAll(settings.inputSelector).find(isVisible) || null;
    }
    const cands = deepQueryAll(INPUTS).filter((el) =>
      !ownUi(el) && isVisible(el) && isEnabled(el) && !el.readOnly &&
      el.getAttribute('contenteditable') !== 'false' &&
      !['search', 'password', 'email'].includes(el.type));
    if (!cands.length) return null;
    if (cands.includes(document.activeElement)) return document.activeElement;
    // Prefer the input closest to the message that asked for approval, then
    // the one lowest on screen (chat boxes usually sit at the bottom).
    return cands
      .map((el) => ({ el, near: closeness(el, near), bottom: el.getBoundingClientRect().bottom }))
      .sort((a, b) => b.near - a.near || b.bottom - a.bottom)[0].el;
  }

  function findSendButton(input) {
    if (settings.sendSelector) {
      return deepQueryAll(settings.sendSelector).find((el) => isVisible(el)) || null;
    }
    const inputRect = input.getBoundingClientRect();
    let node = input.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const match = Array.from(node.querySelectorAll(CLICKABLE)).find((el) => {
        if (ownUi(el) || !isVisible(el) || gap(el.getBoundingClientRect(), inputRect) > NEAR_PX) return false;
        const label = faaNormalize(labelOf(el));
        return label.length <= 60 &&
          !compiled.exclude.some((re) => re.test(label)) &&
          compiled.send.some((re) => re.test(label));
      });
      if (match) return match;
    }
    // Last resort: the submit button of the chat box's own form.
    const submit = input.closest('form')?.querySelector('button[type="submit"], input[type="submit"]');
    return submit && isVisible(submit) ? submit : null;
  }

  function currentText(input) {
    return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : textOf(input);
  }

  function setInputText(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      // Use the prototype setter so React/Angular notice the change.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('insertText', false, text);
    if (!ok || !faaNormalize(textOf(el)).includes(faaNormalize(text))) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  function pressEnter(el) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  async function waitUntil(fn, timeoutMs, stepMs = 200) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v || Date.now() >= end) return v;
      await sleep(stepMs);
    }
  }

  async function sendReply(trigger) {
    const input = findChatInput(trigger.node);
    if (!input) {
      note('Onay mesajı algılandı ama sohbet kutusu bulunamadı (Gelişmiş > giriş seçicisi).');
      return false;
    }
    setInputText(input, settings.replyText);
    await sleep(300);
    const sent = () => !faaNormalize(currentText(input)).includes(compiled.reply);
    if (sent()) {
      note('Cevap sohbet kutusuna yazılamadı (Gelişmiş > giriş seçicisi).');
      return false;
    }

    // The send button is often disabled (or replaced by "stop") while the
    // previous answer is still streaming, so give it a few seconds.
    const btn = await waitUntil(() => {
      const b = findSendButton(input);
      return b && isEnabled(b) ? b : null;
    }, 5000);
    if (btn) {
      clickEl(btn);
      if (await waitUntil(sent, 2000)) return true;
    }
    pressEnter(input);
    if (await waitUntil(sent, 2000)) return true;
    note('Cevap kutuya yazıldı ama gönderilemedi (Gelişmiş > gönder butonu seçicisi).');
    return false;
  }

  // ---------------------------------------------------------------- loop

  function onMutations(mutations) {
    if (!alive()) return shutdown();
    if (!settings.enabled) return;

    const now = Date.now();
    // Skip page load (old chat history) and re-renders caused by our own
    // action. A real batch takes far longer than the cooldown, so the next
    // question is not lost.
    if (settings.mode !== 'click' && now - startedAt > STARTUP_GRACE_MS && now - lastActionAt >= settings.cooldownMs) {
      for (const m of mutations) {
        if (ownUi(m.target) || insideEditable(m.target)) continue;
        const nodes = m.type === 'characterData' ? [m.target] : Array.from(m.addedNodes);
        for (const n of nodes) {
          if (n.nodeType === Node.ELEMENT_NODE && (ownUi(n) || insideEditable(n) || n.matches(EDITABLE))) continue;
          const text = faaNormalize(textOf(n, MAX_MESSAGE_CHARS));
          if (!text || text.length > MAX_MESSAGE_CHARS) continue;
          if (compiled.reply && text.includes(compiled.reply)) continue;
          if (hasTrigger(text)) {
            pendingTrigger = { text: short(text, 120), node: n, at: Date.now() };
            log('Tetik mesajı:', pendingTrigger.text);
          }
        }
      }
    }
    scheduleScan();
  }

  function scheduleScan(delay = 300) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  function limitReached() {
    return settings.maxApprovals > 0 && stats.count >= settings.maxApprovals;
  }

  function scan() {
    if (!alive()) return shutdown();
    if (!settings.enabled || picking || acting) return;
    if (pendingTrigger && Date.now() - pendingTrigger.at > TRIGGER_TTL_MS) pendingTrigger = null;
    if (limitReached()) {
      if (!limitAnnounced) {
        limitAnnounced = true;
        toast(`Limit doldu (${settings.maxApprovals}). Otomatik onay duraklatıldı.`, true);
        note(`Limit doldu (${settings.maxApprovals}); sayacı sıfırlayın veya limiti artırın.`);
      }
      return;
    }
    const now = Date.now();
    if (now - lastActionAt < settings.cooldownMs) return;
    if (now - lastScanAt < MIN_SCAN_GAP_MS) return scheduleScan(MIN_SCAN_GAP_MS);
    lastScanAt = now;

    const wantsButton = settings.mode !== 'message' && findApproveButton();
    const wantsMessage = settings.mode !== 'click' && pendingTrigger;
    if (wantsButton || wantsMessage) act();
  }

  async function act() {
    acting = true;
    try {
      await sleep(jitter(settings.delayMs));
      if (!settings.enabled || picking || limitReached()) return;

      // Re-check after the delay: the dialog may have changed or closed.
      const btn = settings.mode !== 'message' ? findApproveButton() : null;
      if (btn) {
        clicked.add(btn);
        clickEl(btn);
        pendingTrigger = null;
        await record(`Buton tıklandı: "${short(labelOf(btn))}"`);
        return;
      }
      if (settings.mode !== 'click' && pendingTrigger) {
        const trigger = pendingTrigger;
        pendingTrigger = null;
        lastActionAt = Date.now();
        if (await sendReply(trigger)) await record(`Mesaj gönderildi: "${short(settings.replyText)}"`);
      }
    } catch (err) {
      console.warn(TAG, err);
    } finally {
      acting = false;
    }
  }

  function start() {
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    intervalId = setInterval(scan, 2500);
    scheduleScan();
    log('Hazır', settings);
  }

  // ------------------------------------------------------------ page UI

  let ui = null;

  function getUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.id = 'faa-host';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; inset: 0; pointer-events: none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .toast, .banner {
          position: fixed; left: 16px; max-width: min(420px, calc(100vw - 32px));
          font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #fff; background: #1f2937; border-radius: 10px; padding: 10px 14px;
          box-shadow: 0 6px 24px rgba(0,0,0,.25); transition: opacity .3s;
        }
        .toast { bottom: 16px; opacity: 0; }
        .toast.show { opacity: .96; }
        .toast.warn { background: #b45309; }
        .banner { top: 16px; left: 50%; transform: translateX(-50%); background: #1a73e8; display: none; }
        .banner.show { display: block; }
        .box {
          position: fixed; display: none; border: 2px solid #1a73e8; border-radius: 6px;
          background: rgba(26,115,232,.12);
        }
      </style>
      <div class="box"></div>
      <div class="banner"></div>
      <div class="toast"></div>`;
    document.documentElement.appendChild(host);
    ui = {
      host,
      box: root.querySelector('.box'),
      banner: root.querySelector('.banner'),
      toast: root.querySelector('.toast'),
      timer: null,
    };
    return ui;
  }

  function toast(text, warn = false) {
    const u = getUi();
    u.toast.textContent = `Flow Oto-Onay: ${text}`;
    u.toast.classList.toggle('warn', warn);
    u.toast.classList.add('show');
    clearTimeout(u.timer);
    u.timer = setTimeout(() => u.toast.classList.remove('show'), warn ? 8000 : 3500);
  }

  // ------------------------------------------------- "teach the button" mode

  function pickTarget(e) {
    const el = e.composedPath().find((n) => n.nodeType === Node.ELEMENT_NODE);
    if (!el || ownUi(el)) return null;
    return el.closest(CLICKABLE) || el;
  }

  function startPick() {
    if (picking) return;
    picking = true;
    const u = getUi();
    u.banner.textContent = 'Flow Oto-Onay: Onay/devam butonuna tıklayın. (Esc: iptal)';
    u.banner.classList.add('show');

    const block = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      const el = pickTarget(e);
      if (!el) return;
      const r = el.getBoundingClientRect();
      Object.assign(u.box.style, {
        display: 'block', left: `${r.left - 3}px`, top: `${r.top - 3}px`,
        width: `${r.width + 6}px`, height: `${r.height + 6}px`,
      });
    };
    const onClick = (e) => {
      block(e);
      const el = pickTarget(e);
      stop();
      if (el) savePicked(el);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      block(e);
      stop();
      toast('Seçim iptal edildi.');
    };
    const blocked = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];
    function stop() {
      picking = false;
      u.banner.classList.remove('show');
      u.box.style.display = 'none';
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      blocked.forEach((t) => window.removeEventListener(t, block, true));
    }
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    blocked.forEach((t) => window.addEventListener(t, block, true));
  }

  async function savePicked(el) {
    const label = short(el.getAttribute('aria-label') || textOf(el, 200) || el.getAttribute('title') || el.value, 60);
    if (!label) {
      toast('Bu öğede metin yok. Gelişmiş bölümünden CSS seçici girebilirsiniz.', true);
      return;
    }
    const res = await chrome.storage.local.get('settings');
    const s = faaMergeSettings(res.settings);
    if (!s.buttonPhrases.some((p) => faaNormalize(p) === faaNormalize(label))) {
      s.buttonPhrases = [...s.buttonPhrases, label];
    }
    // A phrase the user explicitly taught should not be blocked by the exclude list.
    s.excludePhrases = s.excludePhrases.filter((p) => !faaWordRegExp(p)?.test(faaNormalize(label)));
    await chrome.storage.local.set({ settings: s });
    settings = s;
    compiled = compile(s);

    if (s.requireTrigger && !triggerNear(el)) {
      const ctx = contextOf(el);
      toast(
        `"${label}" kaydedildi, ancak çevresinde tetik ifadesi yok. ` +
        `Popup'ta "Tetik metni gerekli"yi kapatın ya da tetik listesine ekleyin` +
        (ctx ? `: "${ctx}"` : '.'),
        true,
      );
      note(`"${label}" kaydedildi; çevresindeki metin: ${ctx || '(yok)'}`);
    } else {
      toast(`"${label}" kaydedildi. Bir dahaki sefere otomatik tıklanacak.`);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'faa:pick') {
      startPick();
      sendResponse({ ok: true });
    } else if (msg?.type === 'faa:ping') {
      sendResponse({ ok: true, url: location.href });
    }
  });
})();
