(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var btnE = $('e2s'), btnS = $('s2e'), inputEl = $('typedText'), formEl = $('typed'),
      hintEl = $('kbhint'), micBtn = $('mic'), micHintEl = $('michint'), origEl = $('orig'), trEl = $('trText'), trBox = $('tr'), statusEl = $('status');

  var MODES = {
    e2s: { btn: btnE, from: 'en', to: 'es', label: 'E2S', sub: 'English → Español', lang: 'en', spell: 'en-US',
           rec: ['en-US'], micLabel: '🎤 Listen in English', listenMsg: 'Listening… speak English', origLabel: 'English heard', ph: 'English… tap the keyboard mic to speak', prompt: 'Type or speak English…\nEscriba o hable inglés…' },
    s2e: { btn: btnS, from: 'es', to: 'en', label: 'S2E', sub: 'Español → English', lang: 'es', spell: 'es-US',
           rec: ['es-US', 'es-MX'], micLabel: '🎤 Escuchar / Listen in Spanish', listenMsg: 'Escuchando… hable español', origLabel: 'Español oído', ph: 'Español… toque el micrófono del teclado', prompt: 'Escriba o hable español…\nType or speak Spanish…' }
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
    abortListen();                 // a mode switch discards any live recognition (no translate)
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
    micBtn.disabled = false; micBtn.textContent = m.micLabel; micHintEl.textContent = '';
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
    if (session) abortListen();            // never let the mic pick up our own playback
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

  /* ---------- Built-in speech recognition (mic button) ---------- */
  // Fresh SpeechRecognition per tap, wrapped in a session object. Every handler checks it still
  // belongs to the current session, so late events from an old/aborted recognizer do nothing.
  // finishListen() is the ONE teardown: idempotent, reachable from onend, onerror, tap-stop,
  // the watchdogs and page-hide, so the UI can never stay stuck on "Listening".
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isStandalone = !!navigator.standalone ||
              (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  var IOS_HINT = 'Speech can be unreliable in the home-screen app. Try Safari, or use the keyboard mic.';
  var T_START_WAIT = 15000;  // mic never started (permission prompt can take a while)
  var T_NO_SPEECH  = 8000;   // started, but nothing heard
  var T_STALL      = 4000;   // got interim text, but no more results and no onend
  var T_FINAL_WAIT = 1200;   // got a final result, but no onend
  var T_STOP_WAIT  = 1500;   // after tap-stop, onend did not arrive
  var session = null, sessionSeq = 0;

  function clearTimers(s) { if (s.timer) { clearTimeout(s.timer); s.timer = null; } }
  function arm(s, ms, fn) { clearTimers(s); s.timer = setTimeout(function () { if (session === s) fn(); }, ms); }
  function detach(s) {
    var r = s.rec;
    if (!r) return;
    r.onstart = r.onaudiostart = r.onspeechstart = r.onresult = r.onerror = r.onend = r.onnomatch = null;
    try { r.abort(); } catch (e) {}
    s.rec = null;
  }
  function setMicUi(on) {
    micBtn.classList.toggle('on', on);
    micBtn.textContent = on ? '■ Stop' : (mode ? MODES[mode].micLabel : '🎤 Listen / Escuchar');
    inputEl.readOnly = on;      // typing is paused while the recognizer owns the box
  }
  function maybeIosHint() { micHintEl.textContent = (isIOS && isStandalone) ? IOS_HINT : ''; }

  // Drop the session without translating (mode switch, TTS tap).
  function abortListen() {
    var s = session;
    if (!s) return;
    session = null;
    clearTimers(s);
    detach(s);
    setMicUi(false);
  }

  // Tear down the session; translate whatever was heard (final or last interim), else report.
  function finishListen(s, opts) {
    if (session !== s) return;
    opts = opts || {};
    session = null;
    clearTimers(s);
    detach(s);
    setMicUi(false);
    var text = (s.text || '').replace(/\s+/g, ' ').trim();
    try { inputEl.blur(); } catch (e) {}
    if (text) {
      micHintEl.textContent = '';
      inputEl.value = text;
      go(true);                          // same translate-and-clear flow as typing / Enter
      return;
    }
    inputEl.value = '';
    lastOut = null; lastDone = null; showOrig(s.mode, '');
    maybeIosHint();
    if (opts.error) {
      setStatus(opts.status || 'Problem', 'err');
      showError(opts.error);
    } else {
      setStatus('Heard nothing', 'warn');
      trEl.style.whiteSpace = 'pre-line';
      showTr("I didn't hear anything, tap and try again.\nNo oí nada. Toque e intente de nuevo.", 'hint');
    }
  }

  function startListening() {
    if (!mode) { setStatus('Tap E2S or S2E first', 'warn'); return; }
    if (!SR) {
      setStatus('Speech recognition is not available here – use the keyboard mic', 'err');
      maybeIosHint();
      return;
    }
    var cur = session;
    if (cur) {                           // second tap: stop and translate what we have
      if (cur.stopping) return;
      cur.stopping = true;
      setStatus('Stopping…', 'busy');
      try { if (cur.rec) cur.rec.stop(); } catch (e) {}
      arm(cur, T_STOP_WAIT, function () { finishListen(cur); });   // onend may never come on iOS
      return;
    }
    cancelPause(); stopSpeaking();
    translateSeq++; lastDone = null; lastOut = null;   // cancel any in-flight translation
    micHintEl.textContent = '';
    showOrig(mode, '');
    inputEl.value = '';
    try { inputEl.blur(); } catch (e) {}               // close the keyboard; the recognizer owns the box now
    trEl.style.whiteSpace = 'pre-line';
    showTr(MODES[mode].listenMsg, 'hint');
    setStatus('Starting microphone…', 'busy');
    var s = { id: ++sessionSeq, mode: mode, text: '', gotFinal: false, recIndex: 0, stopping: false, rec: null, timer: null };
    session = s;
    setMicUi(true);
    listen(s);                           // synchronously inside the tap (iOS gesture rule)
  }

  function listen(s) {
    var m = MODES[s.mode];
    var r;
    try { r = new SR(); } catch (e) { finishListen(s, { error: 'Could not start the microphone. Try again.', status: 'Mic problem' }); return; }
    s.rec = r;
    r.lang = m.rec[s.recIndex];
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    function mine() { return session === s && s.rec === r; }
    r.onstart = function () {
      if (!mine()) return;
      setStatus('Listening…', 'live');
      arm(s, T_NO_SPEECH, function () { finishListen(s); });
    };
    r.onspeechstart = function () { if (mine()) setStatus('Hearing you…', 'live'); };
    r.onresult = function (ev) {
      if (!mine()) return;
      var interim = '', fin = '';
      for (var i = 0; i < ev.results.length; i++) {
        var res = ev.results[i];
        if (!res || !res[0]) continue;
        if (res.isFinal) fin += res[0].transcript; else interim += res[0].transcript;
      }
      var text = (fin + ' ' + interim).replace(/\s+/g, ' ').trim();
      if (text) s.text = text;           // keep the last non-empty transcript (interim or final)
      if (fin) s.gotFinal = true;
      if (s.text) inputEl.value = s.text;            // live text in the box
      if (s.text) setStatus(s.gotFinal ? 'Got it…' : 'Hearing you…', 'live');
      if (!s.stopping) arm(s, s.gotFinal ? T_FINAL_WAIT : T_STALL, function () { finishListen(s); });
    };
    r.onerror = function (ev) {
      if (!mine()) return;
      var e = ev && ev.error;
      if (e === 'no-speech') { finishListen(s); return; }
      if (e === 'aborted') { finishListen(s, { error: 'Listening was interrupted. Tap 🎤 and try again.', status: 'Interrupted' }); return; }
      if (e === 'language-not-supported' && s.recIndex < m.rec.length - 1) {
        s.recIndex++;                    // bounded fallback: each locale tried at most once, no loop
        detach(s);
        listen(s);
        return;
      }
      var msg, st;
      if (e === 'not-allowed' || e === 'service-not-allowed') {
        st = 'Mic blocked';
        msg = 'Microphone or speech recognition is blocked. Allow it in Settings (Safari / Siri & Dictation), or use the keyboard mic.';
      } else if (e === 'audio-capture') {
        st = 'No microphone';
        msg = 'No microphone found, or another app is using it. Close other apps using the mic and try again.';
      } else if (e === 'network') {
        st = 'No connection';
        msg = 'Speech recognition needs an internet connection. Check your signal and try again.';
      } else if (e === 'language-not-supported') {
        st = 'Language not supported';
        msg = 'This phone does not support that language for speech. Use the keyboard mic instead.';
      } else {
        st = 'Speech error';
        msg = 'Speech error (' + e + '). Tap 🎤 and try again, or use the keyboard mic.';
      }
      finishListen(s, { error: msg, status: st });
    };
    r.onend = function () { if (mine()) finishListen(s); };
    arm(s, T_START_WAIT, function () {
      finishListen(s, { error: 'The microphone did not start. Check permission and tap 🎤 to try again.', status: 'Mic did not start' });
    });
    try { r.start(); }
    catch (e) { finishListen(s, { error: 'Could not start the microphone. Try again.', status: 'Mic problem' }); }
  }

  if (!SR) micBtn.classList.add('na');
  micBtn.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
  micBtn.addEventListener('click', startListening);
  // Backgrounding the app kills the mic; never leave the UI stuck.
  document.addEventListener('visibilitychange', function () { if (document.hidden && session) finishListen(session); });
  window.addEventListener('pagehide', function () { if (session) finishListen(session); });

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
