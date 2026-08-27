(function () {
  'use strict';

  // ── Inject pause-blocker INLINE into real page world ─────────────
  // No external file needed — works in all Kiwi versions
  (function injectMainWorld() {
    const code = [
      '(function(){',
      '  if(window.__tapskipInjected) return;',
      '  window.__tapskipInjected = true;',
      '  var blocking = false;',
      '  var _pause = HTMLMediaElement.prototype.pause;',
      '  HTMLMediaElement.prototype.pause = function(){',
      '    if(blocking) return;',
      '    return _pause.call(this);',
      '  };',
      '  var _load = HTMLMediaElement.prototype.load;',
      '  HTMLMediaElement.prototype.load = function(){',
      '    if(blocking) return;',
      '    return _load.call(this);',
      '  };',
      '  window.addEventListener("__tapskip_on",  function(){ blocking = true;  });',
      '  window.addEventListener("__tapskip_off", function(){ blocking = false; });',
      '})();'
    ].join('\n');

    try {
      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch(e) {}
  })();

  // ── Config ───────────────────────────────────────────────────────
  let skipSec = 5;
  let enabled = true;

  try {
    chrome.storage.sync.get({ skipSec: 5, enabled: true }, function(cfg) {
      skipSec = cfg.skipSec || 5;
      enabled = cfg.enabled !== false;
    });
    chrome.storage.onChanged.addListener(function(changes) {
      if (changes.skipSec) skipSec = changes.skipSec.newValue;
      if (changes.enabled !== undefined) enabled = changes.enabled.newValue;
    });
  } catch(e) {}

  // ── State ────────────────────────────────────────────────────────
  var video       = null;
  var lastTapTime = 0;
  var tapCount    = 0;
  var tapTimer    = null;
  var skipAmount  = 0;
  var currentSide = null;
  var isSkipping  = false;
  var flash       = null;
  var rippleL     = null;
  var rippleR     = null;

  function setSkipping(val) {
    isSkipping = val;
    try {
      window.dispatchEvent(new Event(val ? '__tapskip_on' : '__tapskip_off'));
    } catch(e) {}
  }

  // ── Find best video on page ──────────────────────────────────────
  function findVideo() {
    var all = Array.from(document.querySelectorAll('video'));
    if (!all.length) return;
    var playing = all.find(function(v){ return !v.paused && v.readyState > 1; });
    var ready   = all.find(function(v){ return v.readyState > 0; });
    var vid = playing || ready || all[0];
    if (vid && vid !== video) video = vid;
  }

  findVideo();
  new MutationObserver(findVideo).observe(document.documentElement, {
    childList: true, subtree: true
  });

  // ── touchstart — block pause BEFORE player sees 2nd tap ──────────
  document.addEventListener('touchstart', function(e) {
    if (!enabled) return;
    if (!video) { findVideo(); return; }

    var touch = e.touches[0];
    var y     = touch.clientY;
    if (y > window.innerHeight * 0.84) return;

    var now  = Date.now();
    var diff = now - lastTapTime;

    if (diff < 400 && diff > 0) {
      setSkipping(true);
      e.preventDefault();
      e.stopPropagation();
    }
  }, { passive: false, capture: true });

  // ── touchend — detect double-tap, accumulate, apply skip ─────────
  document.addEventListener('touchend', function(e) {
    if (!enabled || !video) return;

    var now   = Date.now();
    var touch = e.changedTouches[0];
    var x     = touch.clientX;
    var y     = touch.clientY;
    var H     = window.innerHeight;
    var W     = window.innerWidth;

    // Ignore bottom bar
    if (y > H * 0.84) { lastTapTime = 0; return; }

    // Must be inside video
    var r = video.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
      lastTapTime = 0; return;
    }

    var side = x > W / 2 ? 'right' : 'left';
    var diff = now - lastTapTime;

    if (diff < 400 && diff > 0) {
      // Multi-tap: accumulate
      e.preventDefault();
      e.stopPropagation();

      if (currentSide && currentSide !== side) {
        tapCount = 0;
        skipAmount = 0;
      }

      tapCount++;
      skipAmount  = tapCount * skipSec;
      currentSide = side;

      showFlash(side, skipAmount);

      clearTimeout(tapTimer);
      tapTimer = setTimeout(function() {
        if (video) {
          video.currentTime += currentSide === 'right' ? skipAmount : -skipAmount;
        }
        tapCount    = 0;
        skipAmount  = 0;
        currentSide = null;
        setSkipping(false);
      }, 400);

    } else {
      // First tap — reset
      clearTimeout(tapTimer);
      tapCount    = 0;
      skipAmount  = 0;
      currentSide = null;
      setTimeout(function(){ setSkipping(false); }, 450);
    }

    lastTapTime = now;

  }, { passive: false, capture: true });

  // ── UI ───────────────────────────────────────────────────────────
  function ensureUI() {
    if (!rippleL) rippleL = makeRipple('left');
    if (!rippleR) rippleR = makeRipple('right');
    if (!flash) {
      flash = document.createElement('div');
      flash.style.cssText = [
        'position:fixed',
        'z-index:2147483647',
        'pointer-events:none',
        'top:38%',
        'background:rgba(10,10,10,0.85)',
        'color:#fff',
        'padding:13px 28px',
        'border-radius:999px',
        'font-size:23px',
        'font-weight:700',
        'font-family:system-ui,sans-serif',
        'white-space:nowrap',
        'opacity:0',
        'transition:opacity 0.2s ease',
        'box-shadow:0 4px 24px rgba(0,0,0,0.6)',
        'letter-spacing:0.5px',
      ].join(';');
      document.body.appendChild(flash);
    }
  }

  function makeRipple(side) {
    var el = document.createElement('div');
    el.style.cssText = [
      'position:fixed','top:0',
      side === 'left' ? 'left:0' : 'right:0',
      'width:40%','height:100%',
      'pointer-events:none',
      'z-index:2147483646',
      'border-radius:' + (side === 'left' ? '0 60% 60% 0' : '60% 0 0 60%'),
      'background:transparent',
      'transition:background 0.15s ease-out',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function showFlash(side, secs) {
    ensureUI();

    var rip = side === 'left' ? rippleL : rippleR;
    rip.style.background = 'rgba(255,255,255,0.15)';
    clearTimeout(rip._rt);
    rip._rt = setTimeout(function(){ rip.style.background = 'transparent'; }, 380);

    var arrow = side === 'right' ? '>>' : '<<';
    var sign  = side === 'right' ? '+' : '-';
    flash.textContent   = arrow + ' ' + sign + secs + 's';
    flash.style.left    = side === 'left'  ? '6%'   : 'unset';
    flash.style.right   = side === 'right' ? '6%'   : 'unset';
    flash.style.opacity = '1';

    clearTimeout(flash._t);
    flash._t = setTimeout(function(){ flash.style.opacity = '0'; }, 900);
  }

})();
