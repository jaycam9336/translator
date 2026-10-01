(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var btnE = $('e2s'), btnS = $('s2e'), inputEl = $('typedText'), formEl = $('typed'),
      hintEl = $('kbhint'), trEl = $('trText'), trBox = $('tr'), statusEl = $('status');

  var MODES = {
    e2s: { btn: btnE, from: 'en', to: 'es', label: 'E2S', sub: 'English → Español', lang: 'en', spell: 'en-US',
           ph: 'English… tap the keyboard mic to speak', prompt: 'Type or speak English…\nEscriba o hable inglés…' },
    s2e: { btn: btnS, from: 'es', to: 'en', label: 'S2E', sub: 'Español → English', lang: 'es', spell: 'es-US',
           ph: 'Español… toque el micrófono del teclado', prompt: 'Escriba o hable español…\nType or speak Spanish…' }
  };
  var PAUSE_MS = 1200;        // auto-translate this long after the last keystroke / dictation chunk

  var mode = null;            // active mode key, or null before first tap
  var translateSeq = 0;
  var pauseTimer = null;
  var lastDone = null;        // {mode, text} last successfully requested, avoids duplicate translations

  function setBtn(key, on) {
    MODES[key].btn.classList.toggle('on', on);
    MODES[key].btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function setStatus(text, cls) { statusEl.className = cls || ''; statusEl.textContent = text || ''; }
  function showTr(text, cls) {
    trEl.className = cls || '';
    trEl.style.fontSize = '';
    trEl.textContent = text;
    if (!cls) fit();
  }
  function fit() {
    // largest font that fits the translation box
    var lo = 24, hi = 140, best = 24;
    var maxH = trBox.clientHeight - 4;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      trEl.style.fontSize = mid + 'px';
      if (trEl.scrollHeight <= maxH) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    trEl.style.fontSize = best + 'px';
  }
  function showError(msg) { trEl.style.fontSize = ''; showTr(msg, 'err'); }

  /* ---------- Translation with fallbacks ---------- */
  function fetchT(url, ms) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 8000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    }, function (e) { clearTimeout(t); throw e; });
  }
  var providers = [
    // 1. Google translate (dict-chrome-ex endpoint, no key, CORS open)
    function (q, f, t) {
      return fetchT('https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=' + f + '&tl=' + t + '&q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var s = Array.isArray(j) ? j[0] : j;
          if (Array.isArray(s)) s = s[0];
          if (typeof s !== 'string' || !s) throw new Error('empty');
          return s;
        });
    },
    // 2. MyMemory
    function (q, f, t) {
      return fetchT('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + f + '|' + t)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (String(j.responseStatus) !== '200' || !j.responseData || !j.responseData.translatedText) throw new Error('mm ' + j.responseStatus);
          var s = j.responseData.translatedText;
          if (/MYMEMORY WARNING/i.test(s)) throw new Error('quota');
          return s;
        });
    },
    // 3. Apertium (lower quality, last resort)
    function (q, f, t) {
      var c = { en: 'eng', es: 'spa' };
      return fetchT('https://www.apertium.org/apy/translate?q=' + encodeURIComponent(q) + '&langpair=' + c[f] + '%7C' + c[t], 12000)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var s = j && j.responseData && j.responseData.translatedText;
          if (!s) throw new Error('apertium');
          return s.replace(/\*/g, '');
        });
    }
  ];
  function translate(text, from, to) {
    var i = 0;
    function next() {
      if (i >= providers.length) return Promise.reject(new Error('all failed'));
      return providers[i++](text, from, to).catch(next);
    }
    return next();
  }

  function doTranslate(key, text) {
    var m = MODES[key], seq = ++translateSeq;
    lastDone = { mode: key, text: text };
    setStatus('Translating…', 'busy');
    showTr('Translating…', 'busy');
    translate(text, m.from, m.to).then(function (out) {
      if (seq !== translateSeq) return;
      setStatus('Done', 'ok');
      showTr(out);
    }, function () {
      if (seq !== translateSeq) return;
      lastDone = null;      // allow retry with the same text
      setStatus('Translation failed', 'err');
      showError('Could not translate. Check your internet connection and try again.');
    });
  }

  /* ---------- Keyboard input (typing or iOS keyboard dictation) ---------- */
  function cleanText() { return (inputEl.value || '').replace(/\s+/g, ' ').trim(); }
  function cancelPause() { if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; } }

  function go(force) {
    cancelPause();
    if (!mode) return;
    var text = cleanText();
    if (!text) { translateSeq++; lastDone = null; setStatus('Ready', ''); showTr(MODES[mode].prompt, 'hint'); return; }
    if (!force && lastDone && lastDone.mode === mode && lastDone.text === text) return;
    if (force && lastDone && lastDone.mode === mode && lastDone.text === text && statusEl.className === 'ok') return;
    doTranslate(mode, text);
  }

  function onInput() {
    if (!mode) return;
    cancelPause();
    if (!cleanText()) { go(false); return; }
    translateSeq++;                              // an older translation must not overwrite newer typing
    setStatus('Typing… (translates when you pause)', 'live');
    pauseTimer = setTimeout(function () { pauseTimer = null; go(false); }, PAUSE_MS);
  }

  function selectMode(key) {
    var m = MODES[key];
    var same = (mode === key);
    cancelPause();
    if (!same) {
      mode = key;
      translateSeq++; lastDone = null;
      inputEl.value = '';
      showTr(m.prompt, 'hint');
    } else if (cleanText()) {
      // tapping the active button again starts a fresh phrase
      translateSeq++; lastDone = null;
      inputEl.value = '';
      showTr(m.prompt, 'hint');
    }
    setBtn('e2s', key === 'e2s'); setBtn('s2e', key === 's2e');
    inputEl.lang = m.lang;
    inputEl.setAttribute('lang', m.lang);
    inputEl.spellcheck = true;
    inputEl.setAttribute('spellcheck', 'true');
    inputEl.placeholder = m.ph;
    inputEl.setAttribute('autocapitalize', 'sentences');
    inputEl.setAttribute('autocorrect', 'on');
    inputEl.setAttribute('enterkeyhint', 'go');
    trEl.style.whiteSpace = 'pre-line';
    formEl.classList.add('show');
    setStatus('Ready – type, or tap the keyboard mic', '');
    // focus synchronously inside the tap handler so iOS opens the keyboard
    try { inputEl.focus(); } catch (e) {}
  }

  btnE.addEventListener('click', function () { selectMode('e2s'); });
  btnS.addEventListener('click', function () { selectMode('s2e'); });
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('compositionend', onInput);
  formEl.addEventListener('submit', function (ev) {
    ev.preventDefault();                         // Enter / Return ("go")
    if (!mode) return;
    if (!cleanText()) { setStatus('Type or dictate something first', 'warn'); return; }
    go(true);
    inputEl.blur();                              // close keyboard so the big text is visible
  });

  // Keep layout fitted to the visible area when the on-screen keyboard opens/closes.
  function onViewport() {
    var vv = window.visualViewport;
    if (vv) {
      document.documentElement.style.setProperty('--vh', vv.height + 'px');
      document.body.classList.toggle('kb', vv.height < window.innerHeight - 120);
      if (document.body.classList.contains('kb')) window.scrollTo(0, 0);
    }
    if (trEl.className === '' ) fit();
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewport);
    window.visualViewport.addEventListener('scroll', function () { window.scrollTo(0, 0); });
  }
  window.addEventListener('resize', onViewport);
  onViewport();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        try { reg.update(); } catch (e) {}
      }).catch(function () {});
    });
    // A new service worker took over (new app version): reload once, but not while the user has text.
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) { hadController = true; return; }
      reloaded = true;
      if (!cleanText()) location.reload();
    });
  }
})();
