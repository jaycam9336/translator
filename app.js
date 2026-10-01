(function () {
  'use strict';
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var $ = function (id) { return document.getElementById(id); };
  var btnE = $('e2s'), btnS = $('s2e'), origEl = $('orig'), trEl = $('trText'), trBox = $('tr');

  var MODES = {
    e2s: { btn: btnE, rec: ['en-US'], from: 'en', to: 'es', label: 'E2S', sub: 'English → Español', origLabel: 'English heard' },
    s2e: { btn: btnS, rec: ['es-US', 'es-MX'], from: 'es', to: 'en', label: 'S2E', sub: 'Español → English', origLabel: 'Español oído' }
  };

  var active = null;       // mode key currently listening
  var recog = null;
  var gotFinal = false;
  var lastText = '';
  var translateSeq = 0;
  var recIndex = 0;        // which locale in mode.rec we are trying
  var errored = false;

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
  function showOrig(mode, text) {
    origEl.innerHTML = '';
    if (!text) return;
    var b = document.createElement('b'); b.textContent = MODES[mode].origLabel + ': ';
    origEl.appendChild(b); origEl.appendChild(document.createTextNode(text));
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
      showTr(out);
    }, function () {
      if (seq !== translateSeq) return;
      showError('Could not translate. Check your internet connection and try again.');
    });
  }

  /* ---------- Speech ---------- */
  function stopAll() {
    if (recog) { try { recog.onend = null; recog.abort(); } catch (e) {} recog = null; }
    if (active) setBtn(active, false);
    active = null;
  }

  function start(mode) {
    stopAll();
    translateSeq++;
    active = mode; gotFinal = false; lastText = ''; errored = false; recIndex = 0;
    showOrig(mode, '');
    showTr(mode === 'e2s' ? 'Listening… speak English' : 'Escuchando… hable español', 'hint');
    setBtn(mode, true);
    listen(mode);
  }

  function listen(mode) {
    var m = MODES[mode];
    var r = new SR();
    recog = r;
    r.lang = m.rec[recIndex];
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    r.onresult = function (ev) {
      var interim = '', fin = '';
      for (var i = 0; i < ev.results.length; i++) {
        var res = ev.results[i];
        if (res.isFinal) fin += res[0].transcript; else interim += res[0].transcript;
      }
      lastText = (fin + ' ' + interim).trim();
      showOrig(mode, lastText);
      if (fin) gotFinal = true;
    };
    r.onerror = function (ev) {
      var e = ev.error;
      if (e === 'no-speech') return; // onend handles it
      if (e === 'aborted') return;
      if (e === 'language-not-supported' && recIndex < m.rec.length - 1) {
        recIndex++; errored = 'retry'; return;
      }
      errored = true;
      var msg;
      if (e === 'not-allowed' || e === 'service-not-allowed') {
        msg = 'Microphone is blocked. Allow the microphone for this page in your browser settings, then try again.';
      } else if (e === 'audio-capture') {
        msg = 'No microphone found.';
      } else if (e === 'network') {
        msg = 'Speech recognition needs an internet connection. Check your signal and try again.';
      } else if (e === 'language-not-supported') {
        msg = 'This phone does not support that language for speech.';
      } else {
        msg = 'Speech error (' + e + '). Try again.';
      }
      cleanup(mode);
      showError(msg);
    };
    r.onend = function () {
      if (errored === 'retry') { errored = false; listen(mode); return; }
      if (errored) return;
      cleanup(mode);
      if (lastText) {
        doTranslate(mode, lastText);
      } else {
        showTr('Did not hear anything. Tap and try again.\nNo se oyó nada. Intente de nuevo.', 'hint');
        trEl.style.whiteSpace = 'pre-line';
      }
    };
    try { r.start(); }
    catch (e) { cleanup(mode); showError('Could not start the microphone. Try again.'); }
  }

  function cleanup(mode) {
    recog = null; active = null;
    setBtn('e2s', false); setBtn('s2e', false);
  }

  function onTap(mode) {
    if (!SR) return;
    if (active === mode) { // stop -> finish and translate what we have
      if (recog) { try { recog.stop(); } catch (e) {} }
      return;
    }
    trEl.style.whiteSpace = '';
    start(mode);
  }
  btnE.addEventListener('click', function () { onTap('e2s'); });
  btnS.addEventListener('click', function () { onTap('s2e'); });
  window.addEventListener('resize', function () { if (!trEl.className) fit(); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
