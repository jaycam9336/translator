(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var btnE = $('e2s'), btnS = $('s2e'), inputEl = $('typedText'), formEl = $('typed'),
      hintEl = $('kbhint'), origEl = $('orig'), trEl = $('trText'), trBox = $('tr'), statusEl = $('status');

  var MODES = {
    e2s: { btn: btnE, from: 'en', to: 'es', label: 'E2S', sub: 'English → Español', lang: 'en', spell: 'en-US',
           origLabel: 'English heard', ph: 'English… tap the keyboard mic to speak', prompt: 'Type or speak English…\nEscriba o hable inglés…' },
    s2e: { btn: btnS, from: 'es', to: 'en', label: 'S2E', sub: 'Español → English', lang: 'es', spell: 'es-US',
           origLabel: 'Español oído', ph: 'Español… toque el micrófono del teclado', prompt: 'Escriba o hable español…\nType or speak Spanish…' }
  };
  var PAUSE_MS = 2500;        // auto-translate after this many ms of NO input; every keystroke / dictation chunk restarts it

  var mode = null;            // active mode key, or null before first tap
  var translateSeq = 0;
  var pauseTimer = null;
  var lastOut = null;         // {text, lang} of the translation currently shown in the big output
  var lastDone = null;        // {mode, text} last successfully requested, avoids duplicate translations

  function setBtn(key, on) {
    MODES[key].btn.classList.toggle('on', on);
    MODES[key].btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function setStatus(text, cls) { statusEl.className = cls || ''; statusEl.textContent = text || ''; }
  function showOrig(key, text) {
    origEl.textContent = '';
    if (!text) return;
    var b = document.createElement('b'); b.textContent = MODES[key].origLabel + ': ';
    origEl.appendChild(b); origEl.appendChild(document.createTextNode(text));
  }
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
    lastOut = null;
    setStatus('Translating…', 'busy');
    showTr('Translating…', 'busy');
    translate(text, m.from, m.to).then(function (out) {
      if (seq !== translateSeq) return;
      setStatus('Done', 'ok');
      showTr(out);
      lastOut = { text: out, lang: m.to === 'es' ? 'es-MX' : 'en-US' };
      showOrig(key, text);
      clearInputAfterSuccess(text);
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

  // After a successful translation the input is emptied so the next phrase can start right away.
  // Only clear if the box still holds exactly what was translated (never throw away newer typing).
  // Setting .value programmatically fires no 'input' event; the guard flag also covers browsers that do.
  var clearing = false;
  function clearInputAfterSuccess(text) {
    if (cleanText() !== text) return;
    clearing = true;
    inputEl.value = '';
    clearing = false;
    lastDone = null;          // same phrase may be translated again
    // focus is left exactly as it is: still focused (keyboard open) after the pause path,
    // still blurred after Enter.
  }

  function go(force) {
    cancelPause();
    if (!mode) return;
    var text = cleanText();
    if (!text) { translateSeq++; lastDone = null; lastOut = null; showOrig(mode, ''); setStatus('Ready', ''); showTr(MODES[mode].prompt, 'hint'); return; }
    if (!force && lastDone && lastDone.mode === mode && lastDone.text === text) return;
    if (force && lastDone && lastDone.mode === mode && lastDone.text === text && statusEl.className === 'ok') return;
    doTranslate(mode, text);
  }

  function onInput() {
    if (!mode || clearing) return;
    cancelPause();
    if (!cleanText()) {
      if (lastOut) { setStatus('Ready', ''); return; }   // output of the last translation stays up
      go(false); return;
    }
    translateSeq++;                              // an older translation must not overwrite newer typing
    setStatus('Typing… (translates after a ' + (PAUSE_MS / 1000) + ' second pause)', 'live');
    pauseTimer = setTimeout(function () { pauseTimer = null; go(false); }, PAUSE_MS);
  }

  function selectMode(key) {
    var m = MODES[key];
    var same = (mode === key);
    cancelPause();
    if (!same) {
      mode = key;
      translateSeq++; lastDone = null; lastOut = null; stopSpeaking(); showOrig(key, '');
      inputEl.value = '';
      showTr(m.prompt, 'hint');
    } else if (cleanText()) {
      // tapping the active button again starts a fresh phrase
      translateSeq++; lastDone = null; lastOut = null; stopSpeaking(); showOrig(key, '');
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
    inputEl.disabled = false;      // enabled in the same tick, right before focus()
    setStatus('Ready – type, or tap the keyboard mic', '');
    // focus synchronously inside the tap handler so iOS opens the keyboard
    try { inputEl.focus({ preventScroll: true }); } catch (e) { try { inputEl.focus(); } catch (e2) {} }
    if (document.activeElement !== inputEl) { try { inputEl.focus(); } catch (e3) {} }
  }

  btnE.addEventListener('click', function () { selectMode('e2s'); });
  btnS.addEventListener('click', function () { selectMode('s2e'); });
  // Pressing a big button must not move focus off the input (that blurs it, collapses the iOS
  // keyboard, then the click re-focuses it -> flicker, and sometimes the keyboard does not return).
  // Preventing the default of the press keeps the input focused; click still fires normally.
  [btnE, btnS].forEach(function (b) {
    b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    b.addEventListener('pointerdown', function (ev) { if (ev.pointerType === 'mouse') ev.preventDefault(); });
  });
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('compositionend', onInput);
  formEl.addEventListener('submit', function (ev) {
    ev.preventDefault();                         // Enter / Return ("go")
    if (!mode) return;
    if (!cleanText()) { setStatus('Type or dictate something first', 'warn'); return; }
    go(true);
    inputEl.blur();                              // close keyboard so the big text is visible
  });

  /* ---------- Text to speech (reads the translation in the big output) ---------- */
  var ttsBtn = $('tts');
  var synth = window.speechSynthesis;
  var canSpeak = !!(synth && window.SpeechSynthesisUtterance);
  var speaking = false, voices = [], speakToken = 0;

  function loadVoices() { try { voices = synth.getVoices() || []; } catch (e) { voices = []; } }
  if (canSpeak) {
    loadVoices();
    if (synth.addEventListener) synth.addEventListener('voiceschanged', loadVoices);
    else if ('onvoiceschanged' in synth) synth.onvoiceschanged = loadVoices;
  }
  function norm(l) { return String(l || '').toLowerCase().replace('_', '-'); }
  // Natural-voice ranking: Premium/Enhanced/Siri > Google/Natural > any voice in the language.
  // Locale preference only breaks ties inside a tier (es: MX, US, ES, other es-*; en: en-US first).
  var LOCALE_PREF = { es: ['es-mx', 'es-us', 'es-es'], en: ['en-us'] };
  function tierOf(v) {
    var n = String(v.name || '');
    if (/premium|enhanced|siri/i.test(n)) return 0;
    if (/google|natural/i.test(n)) return 1;
    return 2;
  }
  function pickVoice(lang) {
    if (!voices.length) loadVoices();
    var base = norm(lang).split('-')[0], pref = LOCALE_PREF[base] || [];
    var best = null, bestScore = 1e9;
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i], l = norm(v.lang);
      if (l !== base && l.indexOf(base + '-') !== 0) continue;           // wrong language
      var loc = pref.indexOf(l); if (loc < 0) loc = pref.length;          // unlisted locale ranks last
      var score = tierOf(v) * 100 + loc * 10 + (v.localService ? 0 : 1);
      if (score < bestScore) { bestScore = score; best = v; }
    }
    return best;
  }
  function setTtsBtn(on) {
    ttsBtn.classList.toggle('on', on);
    ttsBtn.textContent = on ? 'Stop' : 'Text to Speech';
  }
  function stopSpeaking() {
    speakToken++;
    speaking = false;
    setTtsBtn(false);
    if (canSpeak) { try { synth.cancel(); } catch (e) {} }
  }
  function onTts() {
    if (!canSpeak) { setStatus('Speech playback is not supported on this browser.', 'err'); return; }
    if (speaking) { stopSpeaking(); setStatus('Stopped', ''); return; }   // second tap stops
    if (!lastOut || !lastOut.text) { setStatus('Nothing to read yet', 'warn'); return; }
    try { synth.cancel(); } catch (e) {}                                   // clear anything still queued
    var token = ++speakToken;
    var u = new window.SpeechSynthesisUtterance(lastOut.text);              // created inside the tap (iOS gesture rule)
    var v = pickVoice(lastOut.lang);
    u.lang = v ? v.lang : lastOut.lang;
    if (v) u.voice = v;
    u.rate = 0.95;           // slightly slower than default for clarity
    u.onstart = function () { if (token === speakToken) setStatus('Speaking…', 'live'); };
    u.onend = function () {
      if (token !== speakToken) return;
      speaking = false; setTtsBtn(false); setStatus('Done', 'ok');
    };
    u.onerror = function (ev) {
      if (token !== speakToken) return;
      speaking = false; setTtsBtn(false);
      var e = ev && ev.error;
      if (e === 'canceled' || e === 'interrupted') return;
      setStatus('Could not play audio. Check the volume and silent switch.', 'err');
    };
    speaking = true; setTtsBtn(true); setStatus('Speaking…', 'live');
    try { synth.speak(u); }
    catch (e) { speaking = false; setTtsBtn(false); setStatus('Could not play audio.', 'err'); }
  }
  // Keep the keyboard/focus as it is: don't let the tap pull focus off the input (mouse/Android).
  ttsBtn.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
  ttsBtn.addEventListener('click', onTts);
  if (!canSpeak) { ttsBtn.classList.add('na'); }
  window.addEventListener('pagehide', function () { if (canSpeak) { try { synth.cancel(); } catch (e) {} } });

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
    // A new service worker took over (new app version). Never reload once the user has picked a mode
    // (that would reset the mode, drop focus and close the keyboard mid-use); the new version is used
    // on the next launch. Reload only if the page is still untouched.
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) { hadController = true; return; }
      reloaded = true;
      if (!mode && !cleanText()) location.reload();
    });
  }
})();
