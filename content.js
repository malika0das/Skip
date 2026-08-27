(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────
  //  TapSkip for Kiwi — double-tap left/right on any video to skip.
  //  More taps = more seconds. (v2.1)
  // ─────────────────────────────────────────────────────────────────

  // ── Inject play/pause/load blocker INLINE into the real page world ──
  // No external file needed — works in all Kiwi versions. While a skip
  // gesture is in progress ("blocking"), the page's own pause/play/load
  // calls are swallowed so a double-tap can never pause or reset the
  // video. The "__tapskip_play" event is an escape hatch that lets OUR
  // restore call resume playback while the page is still blocked.
  (function injectMainWorld() {
    var code = [
      '(function(){',
      '  if (window.__tapskipInjected) return;',
      '  window.__tapskipInjected = true;',
      '  var blocking = false;',
      '  var allowPlay = false;',
      '  var _pause = HTMLMediaElement.prototype.pause;',
      '  var _play  = HTMLMediaElement.prototype.play;',
      '  var _load  = HTMLMediaElement.prototype.load;',
      '  HTMLMediaElement.prototype.pause = function(){',
      '    if (blocking) return;',
      '    return _pause.apply(this, arguments);',
      '  };',
      '  HTMLMediaElement.prototype.play = function(){',
      '    if (blocking && !allowPlay) {',
      '      if (typeof Promise !== "undefined") return Promise.resolve();',
      '      return;',
      '    }',
      '    return _play.apply(this, arguments);',
      '  };',
      '  HTMLMediaElement.prototype.load = function(){',
      '    if (blocking) return;',
      '    return _load.apply(this, arguments);',
      '  };',
      '  window.addEventListener("__tapskip_on",   function(){ blocking = true;  });',
      '  window.addEventListener("__tapskip_off",  function(){ blocking = false; allowPlay = false; });',
      '  window.addEventListener("__tapskip_play", function(){ allowPlay = true;  });',
      '})();'
    ].join('\n');

    try {
      var s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { /* Page blocked script injection — extension still works, just less reliably. */ }
  })();

  // ── Config ───────────────────────────────────────────────────────
  var DEFAULT_SKIP = 5;
  var MAX_SKIP    = 60;
  var GESTURE_MS  = 400;   // max gap between taps of one gesture
  var UNBLOCK_MS  = 120;   // keep blocking a moment after the seek is applied
  var TAP_MOVE    = 30;    // max finger travel (px) for a touch to count as a tap

  var skipSec = DEFAULT_SKIP;
  var enabled = true;

  function normalizeSkipSec(v) {
    v = parseInt(v, 10);
    if (!isFinite(v) || v < 1) return DEFAULT_SKIP;
    return Math.min(v, MAX_SKIP);
  }

  try {
    chrome.storage.sync.get({ skipSec: DEFAULT_SKIP, enabled: true }, function (cfg) {
      skipSec = normalizeSkipSec(cfg.skipSec);
      enabled = cfg.enabled !== false;
    });
    chrome.storage.onChanged.addListener(function (changes) {
      if (changes.skipSec) skipSec = normalizeSkipSec(changes.skipSec.newValue);
      if (changes.enabled) enabled = changes.enabled.newValue !== false;
    });
  } catch (e) {}

  // ── State ────────────────────────────────────────────────────────
  var video        = null;
  var lastTapTime  = 0;
  var tapCount     = 0;
  var tapTimer     = null;   // pending seek
  var unblockTimer = null;   // pending "blocking off"
  var skipAmount   = 0;
  var currentSide  = null;
  var wasPlaying   = false;  // play state when the gesture started
  var isSkipping   = false;
  var touchStartX  = 0;      // where the current touch began (movement check)
  var touchStartY  = 0;
  var flash        = null;
  var rippleL      = null;
  var rippleR      = null;

  function setSkipping(val) {
    isSkipping = val;
    try {
      window.dispatchEvent(new Event(val ? '__tapskip_on' : '__tapskip_off'));
    } catch (e) {}
  }

  // ── Video lookup ─────────────────────────────────────────────────
  function visibleRect(v) {
    try {
      var r = v.getBoundingClientRect();
      return (r && r.width > 0 && r.height > 0) ? r : null;
    } catch (e) { return null; }
  }

  // The video element sitting under the given screen point.
  function videoAt(x, y) {
    var all = document.querySelectorAll('video');
    for (var i = 0; i < all.length; i++) {
      var v = all[i];
      var r = visibleRect(v);
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
    }
    return null;
  }

  // Best-guess fallback used while no gesture is running.
  function findVideo() {
    var all = document.querySelectorAll('video');
    if (!all.length) return;
    var playing = null;
    var ready   = null;
    for (var i = 0; i < all.length; i++) {
      var v = all[i];
      if (!visibleRect(v)) continue;
      if (!playing && !v.paused && v.readyState > 1) playing = v;
      if (!ready && v.readyState > 0) ready = v;
    }
    var vid = playing || ready || all[0];
    if (vid && vid !== video) video = vid;
  }

  findVideo();
  try {
    new MutationObserver(findVideo).observe(document.documentElement, {
      childList: true, subtree: true
    });
  } catch (e) {}

  // ── touchstart — pick the video under the finger, track the touch.
  //    We do NOT preventDefault here (that would block scrolling); the
  //    player is kept from reacting to the 2nd tap at touchend instead,
  //    and any play-state toggle that does land is restored at seek time.
  document.addEventListener('touchstart', function (e) {
    if (!enabled) return;
    if (!e.touches || e.touches.length !== 1) {
      lastTapTime = 0; // multi-touch (pinch etc.) breaks any pending gesture
      return;
    }

    var touch = e.touches[0];
    var v = videoAt(touch.clientX, touch.clientY);
    if (!v) return; // never hijack touches outside a video
    var r = visibleRect(v);
    if (!r) return;
    if (touch.clientY > r.top + r.height * 0.85) return; // player controls / bottom bar

    video = v;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;

    var now  = Date.now();
    var diff = now - lastTapTime;

    if (!(lastTapTime > 0 && diff < GESTURE_MS && diff > 0)) {
      // First tap of a gesture — remember the state to restore later
      wasPlaying = !video.paused;
    }
  }, { passive: true, capture: true });

  // ── touchmove — a dragging finger is not a tap; cancel the gesture ──
  document.addEventListener('touchmove', function (e) {
    if (!isSkipping) return;
    var touches = e.touches;
    if (!touches || touches.length !== 1) return;
    var t = touches[0];
    if (Math.abs(t.clientX - touchStartX) > TAP_MOVE ||
        Math.abs(t.clientY - touchStartY) > TAP_MOVE) {
      lastTapTime = 0;
      clearTimeout(tapTimer);
      clearTimeout(unblockTimer);
      tapCount    = 0;
      skipAmount  = 0;
      currentSide = null;
      setSkipping(false);
    }
  }, { passive: true, capture: true });

  // ── touchend — detect the double-tap, accumulate, apply the skip ─
  document.addEventListener('touchend', function (e) {
    if (!enabled) return;
    if (!e.changedTouches || e.changedTouches.length !== 1) return;
    if (e.touches && e.touches.length > 0) return; // a finger is still down → not a tap

    var now   = Date.now();
    var touch = e.changedTouches[0];
    var x = touch.clientX;
    var y = touch.clientY;

    // Re-resolve the video under the finger (it may have appeared/changed)
    var v = videoAt(x, y);
    if (v) video = v;
    if (!video) return;

    var r = visibleRect(video);
    if (!r) return;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
      lastTapTime = 0; // tap outside the video breaks any pending gesture
      return;
    }
    if (y > r.top + r.height * 0.85) {
      lastTapTime = 0; // tap on controls breaks any pending gesture
      return;
    }

    var side = x > r.left + r.width / 2 ? 'right' : 'left';
    var diff = now - lastTapTime;

    // A finger that travelled more than TAP_MOVE is a drag/scroll, not a tap.
    if (Math.abs(x - touchStartX) > TAP_MOVE || Math.abs(y - touchStartY) > TAP_MOVE) {
      lastTapTime = 0; // break any pending gesture
      clearTimeout(tapTimer);
      clearTimeout(unblockTimer);
      tapCount    = 0;
      skipAmount  = 0;
      currentSide = null;
      setSkipping(false);
      return;
    }

    if (lastTapTime > 0 && diff < GESTURE_MS && diff > 0) {
      // Multi-tap: accumulate
      e.preventDefault();
      e.stopPropagation();

      if (currentSide && currentSide !== side) {
        // Switching sides discards the pending accumulation
        clearTimeout(tapTimer);
        tapCount    = 0;
        skipAmount  = 0;
      }
      clearTimeout(unblockTimer); // keep blocking through the whole gesture

      tapCount++;
      skipAmount  = tapCount * skipSec;
      currentSide = side;

      showFlash(side, skipAmount);

      var targetSide   = side;
      var targetAmount = skipAmount;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function () {
        tapCount    = 0;
        skipAmount  = 0;
        currentSide = null;
        if (enabled && video) {
          applySkip(targetSide, targetAmount);
        } else {
          setSkipping(false);
        }
      }, GESTURE_MS);

    } else {
      // First tap — clear any pending gesture state
      clearTimeout(tapTimer);
      clearTimeout(unblockTimer);
      tapCount    = 0;
      skipAmount  = 0;
      currentSide = null;
      setSkipping(false);
    }

    lastTapTime = now;

  }, { passive: false, capture: true });

  // ── Apply the accumulated skip and restore the play state ────────
  function applySkip(side, amount) {
    var target = video.currentTime + (side === 'right' ? amount : -amount);
    var dur = video.duration;
    if (isFinite(dur) && dur > 0) {
      target = Math.max(0, Math.min(target, dur));
    } else {
      target = Math.max(0, target); // live streams: just don't go below 0
    }
    if (isFinite(target)) {
      try { video.currentTime = target; } catch (e) {}
    }

    // The 1st tap of the gesture may have toggled the player's play state
    // (and that toggle can land before or after our blocker engages).
    // Restore whatever state the video had when the gesture started.
    if (wasPlaying && video.paused) {
      try {
        window.dispatchEvent(new Event('__tapskip_play')); // allow OUR play() through
        var p = video.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    }

    // Keep swallowing the player's delayed pause() for a short while,
    // then fully release the blocker.
    clearTimeout(unblockTimer);
    unblockTimer = setTimeout(function () { setSkipping(false); }, UNBLOCK_MS);
  }

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
    rip._rt = setTimeout(function () { rip.style.background = 'transparent'; }, 380);

    var arrow = side === 'right' ? '>>' : '<<';
    var sign  = side === 'right' ? '+' : '-';
    flash.textContent   = arrow + ' ' + sign + secs + 's';
    flash.style.left    = side === 'left'  ? '6%'   : 'unset';
    flash.style.right   = side === 'right' ? '6%'   : 'unset';
    flash.style.opacity = '1';

    clearTimeout(flash._t);
    flash._t = setTimeout(function () { flash.style.opacity = '0'; }, 900);
  }

})();
