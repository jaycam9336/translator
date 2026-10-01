(function () {
  'use strict';
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var $ = function (id) { return document.getElementById(id); };
  var btnE = $('e2s'), btnS = $('s2e'), origEl = $('orig'), trEl = $('trText'), trBox = $('tr'), statusEl = $('status');

  var MODES = {
    e2s: { btn: btnE, rec: ['en-US'], from: 'en', to: 'es', label: 'E2S', sub: 'English → Español', origLabel: 'English heard' },
    s2e: { btn: btnS, rec: ['es-US', 'es-MX'], from: 'es', to: 'en', label: 'S2E', sub: 'Español → English', origLabel: 'Español oído' }
  };

  var translateSeq = 0;

  function setBtn(mode, on) {
    var m = MODES[mode];
    m.btn.classList.toggle('on', on);
    m.btn.innerHTML = on ? 'STOP<small>Listening… tap to stop</small>' : m.label + '<small>' + m.sub + '</small>';
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

  if (!SR) {
    btnE.disabled = btnS.disabled = true;
    showError('This browser cannot listen to speech. Please open this page in Chrome (Android) or Safari (iPhone).\nEste navegador no puede escuchar. Use Chrome (Android) o Safari (iPhone).');
    trEl.style.whiteSpace = 'pre-line';
  }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && SR) {
    showError('The microphone needs a secure (https) page.');
  }

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

  function doTranslate(mode, text) {
    var m = MODES[mode], seq = ++translateSeq;
    showTr('Translating…', 'busy');
    translate(text, m.from, m.to).then(function (out) {
      if (seq !== translateSeq) return;
      setStatus('Done', 'ok');
      showTr(out);
    }, function () {
      if (seq !== translateSeq) return;
      setStatus('Translation failed', 'err');
      showError('Could not translate. Check your internet connection and try again.');
    });
  }

  /* ---------- Speech ---------- */
  // Design: every tap creates a brand-new SpeechRecognition wrapped in a "session".
  // All handlers check that their session is still the current one, so late events
  // (onend/onerror/onresult) from an old/aborted recognizer can never touch a newer one.
  // finish() is the ONE place that tears a session down and resets UI state; it is
  // idempotent and is reachable from onend, onerror, tap-stop, watchdogs and page-hide,
  // so the UI cannot stay stuck on "Listening" if the browser never fires onend.
  var T_START_WAIT = 15000;  // mic never started (permission prompt can take a while)
  var T_NO_SPEECH  = 8000;   // started, but nothing heard
  var T_STALL      = 4000;   // got text, but no further results / no onend
  var T_STOP_WAIT  = 1500;   // after tap-stop, onend did not arrive
  var T_SWITCH     = 250;    // let the mic release after aborting an old session

  var session = null;       // current session object or null
  var sessionSeq = 0;
  var startTimer = null;

  function setStatus(text, cls) {
    statusEl.className = cls || '';
    statusEl.textContent = text || '';
  }
  function setHeard(mode, text, live) {
    origEl.innerHTML = '';
    if (!text) return;
    var b = document.createElement('b');
    b.textContent = (live ? 'Heard: ' : MODES[mode].origLabel + ': ');
    origEl.appendChild(b); origEl.appendChild(document.createTextNode(text));
  }
  function clearTimers(s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  }
  function arm(s, ms, fn) {
    clearTimers(s);
    s.timer = setTimeout(function () { if (session === s) fn(); }, ms);
  }
  function detach(s) {
    var r = s.rec;
    if (!r) return;
    r.onstart = r.onaudiostart = r.onspeechstart = r.onresult = r.onerror = r.onend = r.onnomatch = null;
    try { r.abort(); } catch (e) {}
    s.rec = null;
  }
  function resetButtons() { setBtn('e2s', false); setBtn('s2e', false); }

  // Tear down session s. opts: {error: 'message'} or {} (use heard text / "heard nothing").
  function finish(s, opts) {
    if (session !== s) return;
    opts = opts || {};
    session = null;
    clearTimers(s);
    detach(s);
    resetButtons();
    var text = (s.text || '').trim();
    if (opts.error && !text) {
      setStatus(opts.status || 'Problem', 'err');
      showError(opts.error);
      return;
    }
    if (text) {
      setStatus('Translating…', 'busy');
      setHeard(s.mode, text, false);
      doTranslate(s.mode, text);
    } else {
      setStatus('Heard nothing', 'warn');
      trEl.style.whiteSpace = 'pre-line';
      showTr("I didn't hear anything, tap and try again.\nNo oí nada. Toque e intente de nuevo.", 'hint');
    }
  }

  function abortCurrent() {
    if (startTimer) { clearTimeout(startTimer); startTimer = null; }
    var s = session, had = !!s;
    if (s) {
      session = null;
      clearTimers(s);
      detach(s);
    }
    resetButtons();
    return had;
  }

  function start(mode) {
    var hadOld = abortCurrent();
    translateSeq++;          // cancel any in-flight translation display
    trEl.style.whiteSpace = '';
    setHeard(mode, '', true);
    showTr(mode === 'e2s' ? 'Listening… speak English' : 'Escuchando… hable español', 'hint');
    setStatus('Starting microphone…', 'busy');
    setBtn(mode, true);
    var s = { id: ++sessionSeq, mode: mode, text: '', gotFinal: false, alive: false,
              recIndex: 0, stopping: false, rec: null, timer: null };
    session = s;
    if (hadOld) {
      startTimer = setTimeout(function () { startTimer = null; if (session === s) listen(s); }, T_SWITCH);
    } else {
      listen(s);
    }
  }

  function listen(s) {
    var m = MODES[s.mode];
    var r;
    try { r = new SR(); } catch (e) { finish(s, { error: 'Could not start the microphone. Try again.', status: 'Mic problem' }); return; }
    s.rec = r;
    s.alive = false;
    r.lang = m.rec[s.recIndex];
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;

    function live() { // any sign of life from the recognizer
      if (session !== s || s.rec !== r) return false;
      s.alive = true;
      return true;
    }
    r.onstart = function () {
      if (!live()) return;
      setStatus('Listening…', 'live');
      arm(s, T_NO_SPEECH, function () { finish(s); });
    };
    r.onaudiostart = function () {
      if (!live()) return;
      setStatus('Listening…', 'live');
    };
    r.onspeechstart = function () {
      if (!live()) return;
      setStatus('Hearing you…', 'live');
    };
    r.onresult = function (ev) {
      if (!live()) return;
      var interim = '', fin = '';
      for (var i = 0; i < ev.results.length; i++) {
        var res = ev.results[i];
        if (!res || !res[0]) continue;
        if (res.isFinal) fin += res[0].transcript; else interim += res[0].transcript;
      }
      var text = (fin + ' ' + interim).replace(/\s+/g, ' ').trim();
      if (text) s.text = text;           // keep last non-empty transcript (interim or final)
      if (fin) s.gotFinal = true;
      setHeard(s.mode, s.text, true);
      if (s.text) setStatus(s.gotFinal ? 'Got it…' : 'Hearing you…', 'live');
      // If the browser never delivers onend after results, do not hang.
      arm(s, s.gotFinal ? 1200 : T_STALL, function () { finish(s); });
    };
    r.onerror = function (ev) {
      if (session !== s || s.rec !== r) return;
      var e = ev && ev.error;
      if (e === 'no-speech') { finish(s); return; }                 // -> "heard nothing" (or use text)
      if (e === 'aborted') {                                         // not triggered by us (we detach first)
        finish(s, { error: 'Listening was interrupted. Tap and try again.', status: 'Interrupted' });
        return;
      }
      if (e === 'language-not-supported' && s.recIndex < m.rec.length - 1) {
        // bounded fallback: es-US -> es-MX, each tried at most once, no loops
        s.recIndex++;
        detach(s);
        listen(s);
        return;
      }
      var msg, st;
      if (e === 'not-allowed' || e === 'service-not-allowed') {
        st = 'Mic blocked';
        msg = 'Microphone is blocked. Allow the microphone for this page in your browser settings, then try again.';
      } else if (e === 'audio-capture') {
        st = 'No microphone';
        msg = 'No microphone found, or another app is using it. Close other apps using the mic and try again.';
      } else if (e === 'network') {
        st = 'No connection';
        msg = 'Speech recognition needs an internet connection. Check your signal and try again.';
      } else if (e === 'language-not-supported') {
        st = 'Language not supported';
        msg = 'This phone does not support that language for speech.';
      } else {
        st = 'Speech error';
        msg = 'Speech error (' + e + '). Tap and try again.';
      }
      finish(s, { error: msg, status: st });
    };
    r.onend = function () {
      if (session !== s || s.rec !== r) return;
      finish(s);   // uses last interim/final transcript if present, else "heard nothing"
    };
    arm(s, T_START_WAIT, function () {
      finish(s, { error: 'The microphone did not start. Check microphone permission and tap to try again.', status: 'Mic did not start' });
    });
    try { r.start(); }
    catch (e) { finish(s, { error: 'Could not start the microphone. Try again.', status: 'Mic problem' }); }
  }

  function onTap(mode) {
    if (!SR) return;
    var s = session;
    if (s && s.mode === mode) {           // toggle: second tap stops and translates what we have
      if (s.stopping) return;
      s.stopping = true;
      setStatus(s.text ? 'Stopping…' : 'Stopping…', 'busy');
      try { if (s.rec) s.rec.stop(); } catch (e) {}
      arm(s, T_STOP_WAIT, function () { finish(s); });   // onend may never come on mobile
      return;
    }
    start(mode);                           // idle, or other button: always a fresh recognizer
  }

  // Leaving the page / backgrounding the app kills the mic; never leave the UI stuck.
  function onHidden() {
    if (document.hidden === false) return;
    var s = session;
    if (s) finish(s);
  }
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', function () { var s = session; if (s) finish(s); });

  btnE.addEventListener('click', function () { onTap('e2s'); });
  btnS.addEventListener('click', function () { onTap('s2e'); });
  window.addEventListener('resize', function () { if (!trEl.className) fit(); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        try { reg.update(); } catch (e) {}
      }).catch(function () {});
    });
    // A new service worker took over (new app version): reload once, but never mid-listening.
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) { hadController = true; return; }
      reloaded = true;
      if (session) { window.addEventListener('focus', function () { location.reload(); }, { once: true }); return; }
      location.reload();
    });
  }
})();
