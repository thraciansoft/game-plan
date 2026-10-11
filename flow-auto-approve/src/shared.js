// Shared settings and helpers. Loaded as a classic script by the content
// script, the side panel and the service worker, so it only defines globals.
// `var` rather than `const`: the side panel may inject this file again into a
// tab that already ran it, and a repeated `const` declaration would throw.

var FAA_DEFAULTS = {
  // Answer Flow's "continue?" questions even when no prompt job is running.
  autoReply: true,
  replyText: 'Devam et',
  renameReplyText: 'Evet, devam et',
  // How many images Flow makes before it stops and asks again.
  batchSize: 20,
  // 0 = send every prompt in one message; otherwise split into messages of this size.
  promptsPerMessage: 0,
  // How the prompt box is split: 'auto', 'blank' (blank lines), 'line' (every
  // line) or 'timecode' (each "[00:00 - 00:01]" starts a prompt).
  promptSplit: 'auto',
  renameAfter: true,
  // After generating, ask Flow to check every prompt and redo failed/missing images.
  repairAfter: true,
  repairTemplate:
    'Şimdi 1 ile {toplam} arasındaki tüm promptları kontrol et. Görseli olmayan ya da başarısız olan ' +
    'her prompt için görseli yeniden oluştur. Hepsi tamamsa "Tüm {toplam} promptun görseli hazır" diye yaz.',
  // After renaming, ask Flow to go over every image and fix names it missed.
  renameCheckAfter: true,
  renameCheckTemplate:
    'Şimdi projedeki tüm görsellerin adlarını gözden geçir. Adı {onek}1 ile {onek}{toplam} arasındaki ' +
    'biçimde olmayan her görseli, oluşturulduğu prompt numarasına göre yeniden adlandır. Görseli hiç olmayan ' +
    'bir prompt varsa önce o görseli oluştur, sonra adlandır. Hepsi doğruysa "Tüm {toplam} görselin adı doğru" diye yaz.',
  // When Flow reports failures (rate limit, errors), wait longer and ask it to retry.
  retryText: 'Başarısız olan ya da atlanan görselleri yeniden dene, sonra kaldığın yerden devam et.',
  failurePhrases: [
    'başarısız', 'bir hata oluştu', 'throttled', 'istek limiti', 'istek sınırı', 'kota', 'tamamlanamadı',
    'atlanan', 'eksik kalan', 'failed', 'rate limit', 'quota', 'too many requests',
  ],
  throttleWaitMs: 90000,
  namePrefix: 'gorsel',
  // Placeholders: {adet} prompts in this message, {parti} batch size,
  // {baslangic}/{bitis} first/last prompt number, {toplam} all prompts,
  // {onek} name prefix, {promptlar} the numbered prompt list.
  generateTemplate:
    'Aşağıda numaralı {adet} prompt var. Her prompt için 1 görsel oluştur ve numara sırasını bozma. ' +
    'Görselleri {parti} adetlik partiler halinde oluştur.\n\n{promptlar}',
  renameTemplate:
    'Şimdi oluşturduğun {toplam} görseli prompt numarasına göre yeniden adlandır: ' +
    '1. prompttan oluşan görselin adı {onek}1, 2. prompttan oluşanın adı {onek}2 olsun ' +
    've bu şekilde son görsel {onek}{toplam} olana kadar devam et. Her seferde {parti} görsel adlandır.',
  // Text in the agent's latest message that means it is waiting for a "yes".
  // Substring match, case- and diacritic-insensitive.
  triggerPhrases: [
    'devam edeyim mi', 'devam edelim mi', 'devam etmemi', 'devam etmek ister', 'devam etmek istiyor',
    'devam etmeli miyim', 'devam edilsin mi', 'devam?',
    'isimlendireyim mi', 'isimlendirmeye devam', 'adlandırayım mı', 'adlandırmaya devam',
    'onaylıyor musun', 'onay ver', 'onayınız', 'onayın', 'onay gerek',
    'ister misiniz', 'ister misin', 'geçmemi', 'geçeyim mi', 'geçelim mi', 'onay verebilirsiniz',
    'onaylayabilirsiniz', 'nasıl ilerleyelim', 'ne dersiniz',
    'should i continue', 'shall i continue', 'would you like me to continue',
    'do you want me to continue', 'want to continue', 'like to continue', 'continue?',
    'keep going?', 'proceed?', 'should i rename', 'continue renaming', 'continue naming',
    'your approval', 'approval needed', 'approval required',
  ],
  // Words in Flow's message that say the whole step is finished (whole words).
  // Only trusted when the message has no number or mentions the step's count.
  donePhrases: [
    'tamamı', 'tümü', 'tüm', 'hepsi', 'tamamlandı', 'tamamlanmıştır', 'bitti', 'hazır', 'kalmadı',
    'all', 'complete', 'completed', 'finished', 'done', 'ready', 'nothing left',
  ],
  // Wait this long after the agent's question stops changing before answering.
  questionIdleMs: 3000,
  // With no question visible, the agent's turn counts as finished after the
  // page has been completely still for this long.
  turnEndIdleMs: 30000,
  // Safety stop: pause a step after this many replies beyond the expected count.
  maxExtraReplies: 5,
  sendPhrases: ['send', 'gönder', 'submit', 'arrow_upward', 'arrow_forward', 'send_message'],
  stopPhrases: ['stop', 'durdur', 'stop_circle', 'stop generating', 'yanıtı durdur'],
  inputSelector: '',
  sendSelector: '',
  debug: false,
};

function faaMergeSettings(stored) {
  return Object.assign({}, FAA_DEFAULTS, stored || {});
}

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

// Whole-word matcher for an already-normalized haystack: "stop" matches
// "Stop" and "stop_circle" but not "stopwatch". Null for an empty phrase.
function faaWordRegExp(phrase) {
  const p = faaNormalize(phrase);
  if (!p) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${faaEscapeRegExp(p)}(?![\\p{L}\\p{N}])`, 'u');
}

// A timecode such as "[00:00 - 00:01]" or "[1:02:03.5–1:02:07]".
var FAA_TIMECODE_SOURCE =
  '\\[\\s*\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d+)?\\s*[-–—]\\s*\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d+)?\\s*\\]';

// Splits the prompt box into prompts; whitespace inside a prompt becomes single
// spaces. 'auto' prefers timecodes, then blank lines, then one prompt per line.
function faaSplitPrompts(text, mode = 'auto') {
  const src = String(text || '')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, ' ');
  const clean = (list) => list.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const byBlank = () => clean(src.split(/\n[ \t]*\n/));
  const byLine = () => clean(src.split('\n'));
  const byTimecode = () => {
    const starts = Array.from(src.matchAll(new RegExp(FAA_TIMECODE_SOURCE, 'g')), (m) => m.index);
    if (starts.length < 2) return null;
    // Text before the first timecode stays with the first prompt.
    const cuts = [0, ...starts.slice(1), src.length];
    return clean(cuts.slice(0, -1).map((from, i) => src.slice(from, cuts[i + 1])));
  };
  let prompts;
  let used = mode;
  if (mode === 'blank') prompts = byBlank();
  else if (mode === 'line') prompts = byLine();
  else if (mode === 'timecode') prompts = byTimecode() || clean([src]);
  else {
    const blank = byBlank();
    const timed = byTimecode();
    if (timed && timed.length >= blank.length) [prompts, used] = [timed, 'timecode'];
    else if (blank.length > 1) [prompts, used] = [blank, 'blank'];
    else [prompts, used] = [byLine(), 'line'];
  }
  return { prompts, mode: used };
}

function faaParsePrompts(text, mode = 'auto') {
  return faaSplitPrompts(text, mode).prompts;
}

function faaFill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

// Turns the prompt list into the chat messages the job sends, one per step.
// `expected` is how many times Flow should ask "continue?" during the step;
// `counts` are the numbers Flow may quote when it says the step is finished.
function faaBuildSteps(prompts, s) {
  const batch = Math.max(1, Number(s.batchSize) || 1);
  const per = s.promptsPerMessage > 0 ? s.promptsPerMessage : prompts.length;
  const total = prompts.length;
  const steps = [];
  for (let i = 0; i < total; i += per) {
    const chunk = prompts.slice(i, i + per);
    const start = i + 1;
    const end = i + chunk.length;
    steps.push({
      kind: 'generate',
      label: chunk.length === total ? `Üretim: ${total} prompt` : `Üretim: prompt ${start}–${end}`,
      text: faaFill(s.generateTemplate, {
        adet: chunk.length, parti: batch, baslangic: start, bitis: end, toplam: total, onek: s.namePrefix,
        promptlar: chunk.map((p, j) => `${start + j}. ${p}`).join('\n\n'),
      }),
      expected: Math.ceil(chunk.length / batch) - 1,
      counts: [chunk.length, end, total],
    });
  }
  if (s.repairAfter && total) {
    steps.push({
      kind: 'repair',
      label: `Kontrol: eksik/başarısız görseller (1–${total})`,
      text: faaFill(s.repairTemplate, {
        adet: total, parti: batch, baslangic: 1, bitis: total, toplam: total, onek: s.namePrefix, promptlar: '',
      }),
      expected: 0,
      counts: [total],
    });
  }
  if (s.renameAfter && total) {
    steps.push({
      kind: 'rename',
      label: `İsimlendirme: ${s.namePrefix}1–${s.namePrefix}${total}`,
      text: faaFill(s.renameTemplate, {
        adet: total, parti: batch, baslangic: 1, bitis: total, toplam: total, onek: s.namePrefix, promptlar: '',
      }),
      expected: Math.ceil(total / batch) - 1,
      counts: [total],
    });
  }
  if (s.renameAfter && s.renameCheckAfter && total) {
    steps.push({
      kind: 'renamecheck',
      label: `Ad kontrolü: ${s.namePrefix}1–${s.namePrefix}${total}`,
      text: faaFill(s.renameCheckTemplate, {
        adet: total, parti: batch, baslangic: 1, bitis: total, toplam: total, onek: s.namePrefix, promptlar: '',
      }),
      expected: 0,
      counts: [total],
    });
  }
  return steps;
}
