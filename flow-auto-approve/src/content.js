// Flow Oto-Onay content script.
//
// Runs a prompt job inside Google Flow's chat: sends the numbered prompt list,
// answers every "continue?" Flow asks after each batch with "Devam et", then
// asks Flow to rename the images in prompt order and answers its "rename the
// rest?" questions the same way. Without a job it can still answer the
// "continue?" questions on its own.

(() => {
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  // Injected again after an extension update: an old copy whose extension
  // context is gone shuts itself down, so only skip when the old one still works.
  if (window.__faaAlive?.()) return;
  window.__faaAlive = alive;

  const TAG = '[Flow Oto-Onay]';
  const CLICKABLE = 'button, [role="button"], input[type="button"], input[type="submit"]';
  const INPUTS = [
    'textarea', '[contenteditable="true"]', '[contenteditable=""]',
    '[contenteditable="plaintext-only"]', '[role="textbox"]', 'input[type="text"]', 'input:not([type])',
  ].join(',');
  const EDITABLE = 'textarea, input, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  const STARTUP_GRACE_MS = 3000; // ignore chat history rendered while the page loads
  const MAX_CHUNK_CHARS = 3000; // bigger additions are re-rendered history, not new text
  const MIN_WAIT_AFTER_SEND_MS = 1500;
  const STANDALONE_COOLDOWN_MS = 6000;
  const QUESTION_TTL_MS = 60000;
  const RETRY_DELAY_MS = 5000;
  const NEAR_PX = 250; // max on-screen distance between the chat box and its buttons
  const TICK_MS = 500;

  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Chat history rendered while the page loads is not new text. When the
  // script is injected into a page that has been open for a while, there is
  // nothing to skip.
  const graceUntil = performance.now() < 15000 ? Date.now() + STARTUP_GRACE_MS : 0;
  let settings = faaMergeSettings();
  let compiled = compile(settings);
  let job = null; // the job this tab runs; null when this tab owns none
  let sending = false;
  let retryAt = 0;
  let lastNote = '';
  let observer = null;
  let tickId = null;

  // Page activity since the last message we sent.
  const mon = {
    lastAny: Date.now(), // any DOM change (progress counters, new images, text)
    lastText: 0, // new text with letters in it
    lastNode: null,
    transcript: '',
    markAt: Date.now(),
    echo: '', // the message we just sent, so its chat bubble is not read as the agent's
  };

  const log = (...args) => settings.debug && console.log(TAG, ...args);

  function shutdown() {
    observer?.disconnect();
    clearInterval(tickId);
  }

  function compile(s) {
    const words = (list) => (list || []).map(faaWordRegExp).filter(Boolean);
    return {
      send: words(s.sendPhrases),
      stop: words(s.stopPhrases),
      trigger: (s.triggerPhrases || []).map(faaNormalize).filter(Boolean),
      done: words(s.donePhrases),
      failure: (s.failurePhrases || []).map(faaNormalize).filter(Boolean),
    };
  }

  const hasTrigger = (normalized) => compiled.trigger.some((p) => normalized.includes(p));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitUntil(fn, timeoutMs, stepMs = 200) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v || Date.now() >= end) return v;
      await sleep(stepMs);
    }
  }

  // ---------------------------------------------------------- DOM helpers

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
  // ligature like "arrow_upward" does not glue onto the word next to it.
  function textOf(node, limit = 4000, skipEditable = false) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const out = [];
    let len = 0;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      const tag = parent?.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      if (skipEditable && parent?.closest(EDITABLE)) continue;
      const t = n.data.trim();
      if (!t) continue;
      out.push(t);
      len += t.length + 1;
      if (len > limit) break;
    }
    return out.join(' ');
  }

  function labelOf(el) {
    const bits = [el.getAttribute('aria-label'), el.getAttribute('title'), textOf(el, 200)];
    return bits.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function short(text, n = 60) {
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

  function gap(a, b) {
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return Math.hypot(dx, dy);
  }

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

  // ------------------------------------------------------------- chat box

  function ancestors(node) {
    const list = [];
    for (let n = node; n; n = n.parentNode || n.host) list.push(n);
    return list;
  }

  // Depth of the lowest common ancestor: bigger means "closer together".
  function closeness(a, b) {
    if (!a || !b) return 0;
    const set = new Set(ancestors(a));
    const lca = ancestors(b).find((n) => set.has(n));
    return lca ? ancestors(lca).length : 0;
  }

  function findChatInput() {
    if (settings.inputSelector) {
      return deepQueryAll(settings.inputSelector).find(isVisible) || null;
    }
    const cands = deepQueryAll(INPUTS).filter((el) =>
      !ownUi(el) && isVisible(el) && isEnabled(el) && !el.readOnly &&
      el.getAttribute('contenteditable') !== 'false' &&
      !['search', 'password', 'email'].includes(el.type));
    if (!cands.length) return null;
    if (cands.includes(document.activeElement)) return document.activeElement;
    // Prefer the box closest to the agent's latest message, then the one
    // lowest on screen (chat boxes usually sit at the bottom).
    return cands
      .map((el) => ({ el, near: closeness(el, mon.lastNode), bottom: el.getBoundingClientRect().bottom }))
      .sort((a, b) => b.near - a.near || b.bottom - a.bottom)[0].el;
  }

  // A visible button next to the chat box whose label matches one of `res`.
  function findNearButton(input, res, skip = []) {
    const inputRect = input.getBoundingClientRect();
    let node = input.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const match = Array.from(node.querySelectorAll(CLICKABLE)).find((el) => {
        if (ownUi(el) || !isVisible(el) || gap(el.getBoundingClientRect(), inputRect) > NEAR_PX) return false;
        const label = faaNormalize(labelOf(el));
        return label.length <= 60 && !skip.some((re) => re.test(label)) && res.some((re) => re.test(label));
      });
      if (match) return match;
    }
    return null;
  }

  function findSendButton(input) {
    if (settings.sendSelector) {
      return deepQueryAll(settings.sendSelector).find(isVisible) || null;
    }
    const btn = findNearButton(input, compiled.send, compiled.stop);
    if (btn) return btn;
    // Last resort: the submit button of the chat box's own form.
    const submit = input.closest('form')?.querySelector('button[type="submit"], input[type="submit"]');
    return submit && isVisible(submit) ? submit : null;
  }

  // While Flow is still working the send button usually turns into "stop".
  function agentBusy() {
    const input = findChatInput();
    return !!(input && findNearButton(input, compiled.stop));
  }

  function currentText(input) {
    return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : textOf(input);
  }

  function selectAll(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
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
    const want = faaNormalize(text).slice(0, 40);
    const has = () => faaNormalize(textOf(el)).includes(want);
    // Rich editors (ProseMirror, Lexical, Quill…) keep line breaks on paste.
    selectAll(el);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    if (has()) return;
    selectAll(el);
    document.execCommand('insertText', false, text);
    if (has()) return;
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  function pressEnter(el) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  async function typeAndSend(text) {
    const input = findChatInput();
    if (!input) {
      note('Sohbet kutusu bulunamadı (Gelişmiş > sohbet kutusu seçicisi).');
      return false;
    }
    setInputText(input, text);
    await sleep(300);
    const want = faaNormalize(text).slice(0, 40);
    const typed = () => faaNormalize(currentText(input)).includes(want);
    if (!typed()) {
      note('Metin sohbet kutusuna yazılamadı (Gelişmiş > sohbet kutusu seçicisi).');
      return false;
    }
    // The send button stays disabled (or is a "stop" button) while Flow is
    // still busy, so give it some time. Chat boxes without one send on Enter.
    const found = await waitUntil(() => findSendButton(input), 2000);
    const btn = found && await waitUntil(() => {
      const b = findSendButton(input);
      return b && isEnabled(b) ? b : null;
    }, 10000);
    if (btn) {
      clickEl(btn);
      if (await waitUntil(() => !typed(), 3000)) return true;
    }
    pressEnter(input);
    if (await waitUntil(() => !typed(), 3000)) return true;
    note('Mesaj yazıldı ama gönderilemedi (Gelişmiş > gönder butonu seçicisi).');
    return false;
  }

  // Sends a chat message and restarts activity tracking from that moment.
  async function send(text) {
    sending = true;
    mon.echo = faaNormalize(text);
    try {
      const ok = await typeAndSend(text);
      if (ok) {
        mon.transcript = '';
        mon.lastText = 0;
        mon.markAt = mon.lastAny = Date.now();
        lastNote = '';
      }
      return ok;
    } finally {
      sending = false;
    }
  }

  // ------------------------------------------------------------- activity

  function isEcho(text) {
    const echo = mon.echo;
    if (!echo) return false;
    if (text.length >= 12 && echo.includes(text)) return true; // a piece of our message
    return text.includes(echo) && text.length <= echo.length + 40; // our message bubble
  }

  function onMutations(mutations) {
    if (!alive()) return shutdown();
    const now = Date.now();
    for (const m of mutations) {
      if (ownUi(m.target) || insideEditable(m.target)) continue;
      mon.lastAny = now;
      if (now < graceUntil) continue;
      const nodes = m.type === 'characterData' ? [m.target] : Array.from(m.addedNodes);
      for (const n of nodes) {
        if (n.nodeType === Node.ELEMENT_NODE && (ownUi(n) || n.matches(EDITABLE))) continue;
        const text = faaNormalize(textOf(n, MAX_CHUNK_CHARS, true));
        if (!text || text.length > MAX_CHUNK_CHARS || !/\p{L}/u.test(text) || isEcho(text)) continue;
        mon.lastText = now;
        mon.lastNode = n;
        mon.transcript = `${mon.transcript} ${text}`.slice(-20000);
      }
    }
  }

  const agentAsked = () => !!mon.transcript && hasTrigger(mon.transcript.slice(-600));
  // Flow reported failed images (errors, rate limit) since our last message.
  const flowFailed = () => compiled.failure.some((p) => mon.transcript.includes(p));

  // Flow says the step is finished ("Listedeki 144 sahnenin tamamı …
  // oluşturuldu"). Only the sentence with the last such word counts, and a
  // number in it that does not match ("84 sahnenin tamamı" when 144 prompts
  // were sent) means Flow stopped early.
  // Flow's own sentences since our last message: prompt texts it echoes back
  // ("Tümünü göster") are dropped, so words inside a prompt never count.
  let echoCache = { id: null, text: '' };
  function agentSentences() {
    if (job && echoCache.id !== job.id) {
      echoCache = { id: job.id, text: faaNormalize(job.steps.map((st) => st.text).join(' ')) };
    }
    const echo = job ? echoCache.text : mon.echo;
    return mon.transcript.split(/(?<=[.!?])\s+/).map((x) => x.trim())
      .filter((x) => x && !(x.length >= 8 && echo.includes(x.replace(/^\d+\.\s*/, ''))));
  }

  // Flow ended its turn with a question we have no phrase for
  // ("…geçmemi ister misiniz?").
  function endsWithQuestion() {
    return agentSentences().slice(-3).some((x) => x.endsWith('?'));
  }

  function saysFinished(step) {
    // The sentence holding the last "done" word ("Listedeki 144 sahnenin
    // tamamı … oluşturuldu"); a number in it that does not match the step's
    // count ("84 sahnenin tamamı" for 144 prompts) means Flow stopped early.
    const sentence = agentSentences().reverse().find((x) => compiled.done.some((re) => re.test(x)));
    if (!sentence) return false;
    const numbers = (sentence.match(/\d+/g) || []).map(Number);
    return !numbers.length || (step.counts || []).some((n) => numbers.includes(n));
  }

  // ------------------------------------------------------------------ job

  function addLog(msg) {
    log(msg);
    job.log = [...(job.log || []).slice(-99), { t: Date.now(), msg }];
  }

  async function saveJob() {
    if (job && alive()) await chrome.storage.local.set({ job });
  }

  function note(text) {
    if (text === lastNote) return;
    lastNote = text;
    log(text);
    if (job) {
      job.note = text;
      addLog(`⚠ ${text}`);
      saveJob().catch(() => {});
    }
  }

  async function pauseJob(reason) {
    job.status = 'paused';
    job.note = reason;
    addLog(`Duraklatıldı: ${reason}`);
    toast(`Duraklatıldı: ${reason}`, true);
    await saveJob();
  }

  async function finishJob() {
    job.status = 'done';
    job.finishedAt = Date.now();
    job.note = '';
    addLog('Görev tamamlandı.');
    toast('Görev tamamlandı ✓');
    await saveJob();
  }

  async function sendFailed() {
    job.failures = (job.failures || 0) + 1;
    retryAt = Date.now() + RETRY_DELAY_MS;
    if (job.failures >= 3) return pauseJob(lastNote || 'Mesaj gönderilemedi.');
    return saveJob();
  }

  async function jobReply(step, reason) {
    if (job.replies >= step.expected + settings.maxExtraReplies) {
      return pauseJob('Flow beklenenden çok durdu ya da tüm promptların bittiğini söylemedi. Flow\'u kontrol edip Sürdür veya Sonraki adım\'a basın.');
    }
    let text = settings.replyText;
    if (step.kind === 'rename' || step.kind === 'renamecheck') text = settings.renameReplyText;
    else if (step.kind === 'repair' || flowFailed()) text = settings.retryText;
    if (!(await send(text))) return sendFailed();
    job.replies++;
    job.totalReplies = (job.totalReplies || 0) + 1;
    job.failures = 0;
    job.note = '';
    addLog(`"${text}" yazıldı (${reason}). Onay ${job.replies}/${step.expected}`);
    toast(`"${text}" yazıldı (${job.replies}/${step.expected})`);
    await saveJob();
  }

  async function nextStep(reason) {
    addLog(`Adım tamamlandı (${reason}): ${job.steps[job.stepIndex].label}`);
    job.stepIndex++;
    job.stepSent = false;
    job.replies = 0;
    if (job.stepIndex >= job.steps.length) return finishJob();
    await saveJob();
  }

  async function jobTick() {
    const step = job.steps[job.stepIndex];
    if (!step) return finishJob();
    const now = Date.now();
    if (now < retryAt) return;

    if (!job.stepSent) {
      if (agentBusy() || now - mon.lastAny < 1000) return; // wait for a quiet moment
      if (!(await send(step.text))) return sendFailed();
      job.stepSent = true;
      job.replies = 0;
      job.failures = 0;
      job.note = '';
      addLog(`Adım ${job.stepIndex + 1}/${job.steps.length} gönderildi: ${step.label}`);
      toast(`Adım ${job.stepIndex + 1}/${job.steps.length}: ${step.label}`);
      return saveJob();
    }

    if (now - mon.markAt < MIN_WAIT_AFTER_SEND_MS || agentBusy()) return;
    const textIdle = now - Math.max(mon.lastText, mon.markAt);
    // After errors or rate limiting, give Flow's quota time to recover before
    // asking it to retry.
    if (step.kind !== 'rename' && step.kind !== 'renamecheck' && flowFailed() && now - mon.lastAny < settings.throttleWaitMs) return;
    if (agentAsked() && textIdle >= settings.questionIdleMs) {
      // "Tüm 144 görsel oluşturuldu. Başka bir şey ister misiniz?" is the end, not a batch question.
      if (saysFinished(step)) return nextStep('Flow bitirdiğini söyledi');
      return jobReply(step, 'soru algılandı');
    }
    if (now - mon.lastAny < settings.turnEndIdleMs) return;
    // Flow went quiet without a question we know. Move on only when it said
    // the whole step is done; otherwise it stopped early or is waiting in
    // other words, so nudge it on (jobReply pauses if this keeps happening).
    if (endsWithQuestion()) return jobReply(step, 'Flow soru sordu');
    if (saysFinished(step)) return nextStep('Flow bitirdiğini söyledi');
    return jobReply(step, 'Flow durdu ama hepsinin bittiğini söylemedi');
  }

  async function standaloneTick() {
    if (job?.status === 'paused') return; // the user paused on purpose
    const now = Date.now();
    if (now - mon.markAt < STANDALONE_COOLDOWN_MS || now - mon.lastText > QUESTION_TTL_MS) return;
    if (now - mon.lastText < settings.questionIdleMs || !agentAsked() || agentBusy()) return;
    if (!(await send(settings.replyText))) return;
    toast(`"${settings.replyText}" yazıldı`);
    const { standalone } = await chrome.storage.local.get('standalone');
    await chrome.storage.local.set({
      standalone: { count: (standalone?.count || 0) + 1, lastAt: Date.now() },
    });
  }

  async function tick() {
    if (!alive()) return shutdown();
    if (sending) return;
    try {
      if (job?.status === 'running') await jobTick();
      else if (settings.autoReply) await standaloneTick();
    } catch (err) {
      console.warn(TAG, err);
    }
  }

  // ---------------------------------------------------------- diagnostics

  function describe(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class');
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      class: short(cls, 160) || undefined,
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      title: el.getAttribute('title') || undefined,
      placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || undefined,
      contenteditable: el.getAttribute('contenteditable') ?? undefined,
      text: short(textOf(el, 200), 80) || undefined,
      visible: isVisible(el),
      disabled: !isEnabled(el) || undefined,
      rect: [r.left, r.top, r.width, r.height].map(Math.round),
    };
  }

  // The page without scripts and media URLs (signed image links would give
  // access to the user's images), small enough to attach to a bug report.
  function pageSnapshot(limit = 3000000) {
    const build = (dropStyles) => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script, noscript, iframe, #faa-host').forEach((n) => n.remove());
      if (dropStyles) clone.querySelectorAll('style, link').forEach((n) => n.remove());
      for (const el of clone.querySelectorAll('*')) {
        for (const { name, value } of Array.from(el.attributes)) {
          if (name.startsWith('on')) el.removeAttribute(name);
          else if (['src', 'srcset', 'poster', 'href', 'action', 'data-src'].includes(name)) el.setAttribute(name, '');
          else if (value.length > 300) el.setAttribute(name, value.slice(0, 300));
        }
      }
      return `<!doctype html>\n${clone.outerHTML}`;
    };
    let html = build(false);
    if (html.length > limit) html = build(true);
    return html.length > limit ? html.slice(0, limit) : html;
  }

  function diagnose() {
    const input = findChatInput();
    const near = [];
    if (input) {
      const inputRect = input.getBoundingClientRect();
      for (const el of deepQueryAll(CLICKABLE)) {
        if (ownUi(el) || gap(el.getBoundingClientRect(), inputRect) > NEAR_PX) continue;
        near.push(describe(el));
        if (near.length >= 30) break;
      }
    }
    const now = Date.now();
    return {
      version: chrome.runtime.getManifest().version,
      at: new Date().toISOString(),
      url: location.origin + location.pathname,
      userAgent: navigator.userAgent,
      detection: {
        input: describe(input),
        send: input ? describe(findSendButton(input)) : null,
        stop: input ? describe(findNearButton(input, compiled.stop)) : null,
        busy: agentBusy(),
        asked: agentAsked(),
        idleSec: Math.round((now - mon.lastAny) / 1000),
        textIdleSec: Math.round((now - Math.max(mon.lastText, mon.markAt)) / 1000),
      },
      inputCandidates: deepQueryAll(INPUTS).filter((el) => !ownUi(el)).slice(0, 15).map(describe),
      buttonsNearInput: near,
      transcriptTail: mon.transcript.slice(-1500),
      job: job && {
        status: job.status,
        stepIndex: job.stepIndex,
        stepSent: job.stepSent,
        replies: job.replies,
        steps: job.steps.map(({ kind, label, expected }) => ({ kind, label, expected })),
        log: (job.log || []).slice(-30),
      },
      settings,
    };
  }

  // ------------------------------------------------------------- commands

  function newJob(prompts, tabId) {
    return {
      id: instanceId + Date.now(),
      owner: instanceId,
      tabId,
      status: 'running',
      promptCount: prompts.length,
      steps: faaBuildSteps(prompts, settings),
      stepIndex: 0,
      stepSent: false,
      replies: 0,
      totalReplies: 0,
      failures: 0,
      note: '',
      log: [],
      startedAt: Date.now(),
    };
  }

  async function handleCommand(msg) {
    await ready; // a freshly injected copy may get a command before its settings load
    const mine = job && job.owner === instanceId;
    switch (msg.type) {
      case 'faa:ping':
        return { ok: true };
      case 'faa:status':
        return {
          ok: true,
          owner: !!mine,
          hasInput: !!findChatInput(),
          busy: agentBusy(),
          idleSec: Math.round((Date.now() - mon.lastAny) / 1000),
          textIdleSec: Math.round((Date.now() - Math.max(mon.lastText, mon.markAt)) / 1000),
          asked: agentAsked(),
        };
      case 'faa:diagnose': {
        const report = diagnose();
        if (msg.full) report.html = pageSnapshot();
        return { ok: true, report };
      }
      case 'faa:start': {
        if (mine && job.status === 'running') return { ok: false, error: 'Bu sekmede zaten çalışan bir görev var.' };
        const prompts = (msg.prompts || []).filter(Boolean);
        if (!prompts.length) return { ok: false, error: 'Prompt bulunamadı.' };
        job = newJob(prompts, msg.tabId);
        retryAt = 0;
        addLog(`Görev başladı: ${prompts.length} prompt, ${job.steps.length} adım.`);
        await saveJob();
        return { ok: true };
      }
      case 'faa:resume': {
        const { job: stored } = await chrome.storage.local.get('job');
        if (!stored || stored.status === 'done') return { ok: false, error: 'Sürdürülecek görev yok.' };
        job = Object.assign(stored, { owner: instanceId, tabId: msg.tabId, status: 'running', failures: 0, note: '' });
        retryAt = 0;
        // Start the idle clocks now; if Flow is already waiting, the
        // turn-end rule answers it after `turnEndIdleMs`.
        mon.transcript = '';
        mon.markAt = mon.lastAny = Date.now();
        addLog('Sürdürüldü.');
        await saveJob();
        return { ok: true };
      }
      case 'faa:pause':
      case 'faa:stop':
      case 'faa:next': {
        if (!mine) return { ok: false, notOwner: true };
        if (msg.type === 'faa:pause') {
          if (job.status === 'running') await pauseJob('Kullanıcı duraklattı.');
        } else if (msg.type === 'faa:stop') {
          job.status = 'stopped';
          addLog('Görev durduruldu.');
          await saveJob();
        } else {
          await nextStep('elle geçildi');
        }
        return { ok: true };
      }
      default:
        return null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.type?.startsWith('faa:')) return false;
    handleCommand(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  });

  // ------------------------------------------------------------- storage

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = faaMergeSettings(changes.settings.newValue);
      compiled = compile(settings);
    }
    // Another tab took the job over, or the side panel cleared it.
    if (changes.job && job && changes.job.newValue?.owner !== instanceId) job = null;
  });

  const ready = chrome.storage.local.get('settings').then((res) => {
    settings = faaMergeSettings(res.settings);
    compiled = compile(settings);
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    tickId = setInterval(tick, TICK_MS);
    log('Hazır');
  });

  // -------------------------------------------------------------- page UI

  let ui = null;

  function toast(text, warn = false) {
    if (!ui || !ui.host.isConnected) {
      const host = document.createElement('div');
      host.id = 'faa-host';
      host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; inset: 0; pointer-events: none;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .toast {
            position: fixed; left: 16px; bottom: 16px; max-width: min(420px, calc(100vw - 32px));
            font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            color: #fff; background: #1f2937; border-radius: 10px; padding: 10px 14px;
            box-shadow: 0 6px 24px rgba(0,0,0,.25); opacity: 0; transition: opacity .3s;
          }
          .toast.show { opacity: .96; }
          .toast.warn { background: #b45309; }
        </style>
        <div class="toast"></div>`;
      document.documentElement.appendChild(host);
      ui = { host, el: root.querySelector('.toast'), timer: null };
    }
    ui.el.textContent = `Flow Oto-Onay: ${text}`;
    ui.el.classList.toggle('warn', warn);
    ui.el.classList.add('show');
    clearTimeout(ui.timer);
    ui.timer = setTimeout(() => ui.el.classList.remove('show'), warn ? 8000 : 3500);
  }
})();
