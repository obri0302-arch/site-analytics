/**
 * Site Analytics Tracker
 * Підключення: <script src="https://YOUR_SERVER/tracker.js" data-endpoint="https://YOUR_SERVER" data-site="my-site"></script>
 *
 * Збирає:
 *  - кліки (координати, елемент, текст)
 *  - рух миші (для heatmap, з throttle)
 *  - глибину скролу (max % і таймлайн досягнення секцій)
 *  - час на сторінці / час до взаємодії
 *  - "rage clicks" (швидкі повторні кліки в одну точку)
 *  - точку виходу (last scroll position перед закриттям)
 *  - viewport / device info
 */
(function () {
  var scriptTag = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var ENDPOINT = scriptTag.getAttribute('data-endpoint') || '';
  var SITE_ID = scriptTag.getAttribute('data-site') || 'default';

  if (!ENDPOINT) {
    console.warn('[analytics] data-endpoint не вказано — дані не будуть надіслані');
    return;
  }

  var sessionId = (function () {
    var key = '_an_session_id';
    var existing = sessionStorage.getItem(key);
    if (existing) return existing;
    var id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(key, id);
    return id;
  })();

  var pageLoadTime = Date.now();
  var maxScrollPct = 0;
  var clicks = [];
  var moves = [];
  var lastMoveSent = 0;
  var rageClickBuffer = [];

  function getSelector(el) {
    if (!el || el === document) return 'document';
    if (el.id) return '#' + el.id;
    var cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return (el.tagName ? el.tagName.toLowerCase() : '') + cls;
  }

  function send(type, payload) {
    var body = JSON.stringify(Object.assign({
      type: type,
      site: SITE_ID,
      session: sessionId,
      url: location.pathname + location.search,
      ts: Date.now(),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      page_w: document.documentElement.scrollWidth,
      page_h: document.documentElement.scrollHeight
    }, payload));

    if (navigator.sendBeacon) {
      var blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(ENDPOINT + '/collect', blob);
    } else {
      fetch(ENDPOINT + '/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    }
  }

  // ---- Кліки ----
  document.addEventListener('click', function (e) {
    var el = e.target;
    var xPct = (e.pageX / document.documentElement.scrollWidth) * 100;
    var yPct = (e.pageY / document.documentElement.scrollHeight) * 100;

    var now = Date.now();
    rageClickBuffer.push({ x: e.pageX, y: e.pageY, t: now });
    rageClickBuffer = rageClickBuffer.filter(function (c) { return now - c.t < 1000; });
    var isRage = rageClickBuffer.length >= 3 &&
      rageClickBuffer.every(function (c) {
        return Math.abs(c.x - e.pageX) < 30 && Math.abs(c.y - e.pageY) < 30;
      });

    send('click', {
      x: e.pageX,
      y: e.pageY,
      x_pct: xPct,
      y_pct: yPct,
      selector: getSelector(el),
      text: (el.innerText || '').slice(0, 60),
      rage: isRage
    });
  }, true);

  // ---- Рух миші (throttled, для heatmap) ----
  document.addEventListener('mousemove', function (e) {
    var now = Date.now();
    if (now - lastMoveSent < 400) return; // ~2.5 точки/сек
    lastMoveSent = now;
    var xPct = (e.pageX / document.documentElement.scrollWidth) * 100;
    var yPct = (e.pageY / document.documentElement.scrollHeight) * 100;
    send('move', { x: e.pageX, y: e.pageY, x_pct: xPct, y_pct: yPct });
  });

  // ---- Скрол / глибина ----
  function getScrollPct() {
    var doc = document.documentElement;
    var scrollTop = window.scrollY || doc.scrollTop;
    var max = doc.scrollHeight - window.innerHeight;
    if (max <= 0) return 100;
    return Math.min(100, Math.round((scrollTop / max) * 100));
  }

  window.addEventListener('scroll', function () {
    var pct = getScrollPct();
    if (pct > maxScrollPct) {
      maxScrollPct = pct;
      // фіксуємо контрольні точки 25/50/75/90/100%
      [25, 50, 75, 90, 100].forEach(function (mark) {
        if (maxScrollPct >= mark && maxScrollPct - 5 < mark) {
          send('scroll_depth', { depth: mark, time_to_reach_ms: Date.now() - pageLoadTime });
        }
      });
    }
  });

  // ---- Перший клік / перша взаємодія (time to interact) ----
  var interacted = false;
  ['click', 'keydown', 'scroll', 'mousemove'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      if (interacted) return;
      interacted = true;
      send('first_interaction', { ms: Date.now() - pageLoadTime, event: ev });
    }, { once: true });
  });

  // ---- Вихід зі сторінки ----
  function onExit() {
    send('exit', {
      time_on_page_ms: Date.now() - pageLoadTime,
      max_scroll_pct: maxScrollPct,
      last_scroll_pct: getScrollPct()
    });
  }
  window.addEventListener('beforeunload', onExit);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') onExit();
  });

  // ---- Старт сесії ----
  send('pageview', {
    referrer: document.referrer,
    title: document.title
  });
})();
