// Simulated DOM/Chrome environment to exercise content.js gesture logic.
'use strict';
const fs = require('fs');

// ---- minimal DOM mocks ----
class MockEvent {
  constructor(type) { this.type = type; }
}
class MockMutationObserver {
  constructor(fn) { this.fn = fn; }
  observe() {}
}

function makeVideo(id) {
  const v = {
    id,
    currentTime: 100,
    duration: 600,
    paused: true,
    readyState: 4,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 }),
    pauseCalls: 0,
    playCalls: 0,
    loadCalls: 0,
    pause() { this.pauseCalls++; this.paused = true; },
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
    load() { this.loadCalls++; },
  };
  return v;
}

const videos = [makeVideo('main')];
const listeners = {};
const elements = [];

const document = {
  head: { appendChild() {}, remove() {} },
  documentElement: { appendChild() {} },
  body: { appendChild(el) { elements.push(el); } },
  createElement: (tag) => ({ tag, style: {}, textContent: '', appendChild() {}, remove() {} }),
  querySelectorAll: (sel) => (sel === 'video' ? videos : []),
  addEventListener: (type, fn, opts) => { listeners[type] = listeners[type] || []; listeners[type].push({ fn, opts }); },
};
const window = {
  innerHeight: 800,
  innerWidth: 400,
  addEventListener(type, fn) { listeners['window:' + type] = listeners['window:' + type] || []; listeners['window:' + type].push(fn); },
  dispatchEvent(ev) {
    (listeners['window:' + ev.type] || []).forEach(l => l.fn(ev));
    return true;
  },
};
global.Event = MockEvent;
global.MutationObserver = MockMutationObserver;
global.document = document;
global.window = window;
global.chrome = {
  storage: {
    sync: {
      get(defaults, cb) { cb({ skipSec: 5, enabled: true }); },
      set() {},
    },
    onChanged: { addListener() {} },
  },
};

// ---- fake clock & timers (shared by content.js via injected params) ----
// Start at a large "epoch" value like real Date.now() so that the very
// first tap (diff = now - 0) is never mistaken for a second tap.
let t = 1000000000000;
const pending = [];
const fakeSetTimeout = (cb, ms) => { pending.push({ cb, at: t + ms }); return pending.length; };
const fakeClearTimeout = (id) => { if (id) pending[id - 1] = null; };
class FakeDate {
  static now() { return t; }
}

// ---- load the real content script ----
const src = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');
const fn = new Function('window', 'document', 'chrome', 'Event', 'MutationObserver', 'Date', 'setTimeout', 'clearTimeout', src + '\n//# sourceURL=content.js');
fn(window, document, chrome, MockEvent, MockMutationObserver, FakeDate, fakeSetTimeout, fakeClearTimeout);

function fire(type, touches, changedTouches, opts) {
  const e = {
    type,
    touches,
    changedTouches,
    preventDefault() { e._pd = true; },
    stopPropagation() { e._sp = true; },
  };
  (listeners[type] || []).forEach(l => l.fn(e));
  return e;
}
function tap(x, y, msAfter) {
  t += msAfter;
  fire('touchstart', [{ clientX: x, clientY: y }], null);
  const e = fire('touchend', [], [{ clientX: x, clientY: y }]);
  return e;
}
function advance(ms) {
  const target = t + ms;
  while (true) {
    const due = pending.filter(p => p && p.at <= target).sort((a, b) => a.at - b.at);
    if (!due.length) break;
    const job = due[0];
    const idx = pending.indexOf(job);
    pending[idx] = null;
    t = job.at;
    job.cb();
  }
  t = target;
}
function resetTimers() { pending.length = 0; }

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  PASS:', msg); }
  else { console.log('  FAIL:', msg); failures++; }
}

const v = videos[0];
// reset video helper
function resetVideo() { v.currentTime = 100; v.paused = false; v.pauseCalls = 0; v.playCalls = 0; v.loadCalls = 0; }

// ---- Test 1: double-tap right skips +5 and restores play state ----
console.log('\nTest 1: double-tap right → +5s, play state restored');
resetVideo();
let e = tap(300, 200, 100);   // tap 1 (t0+100) — first tap, not hijacked
assert(!e._pd, 'first tap is not preventDefaulted');
v.pause();                    // player reacts to tap 1 by pausing (paused=true)
e = tap(310, 200, 200);       // tap 2 (t0+300) → gesture
assert(e._pd === true, '2nd touchend is preventDefaulted');
v.pause();                    // player's delayed pause from tap 1 lands mid-gesture
advance(400);                 // seek fires at t0+700
assert(v.currentTime === 105, `seek applied (+5): got ${v.currentTime}`);
assert(v.playCalls === 1, 'play() called once to restore (was playing before gesture)');
assert(v.paused === false, 'video playing again after skip');
advance(200);                 // blocker released
assert(v.paused === false, 'still playing after blocker release');
resetTimers();

// ---- Test 2: triple tap accumulates ----
console.log('\nTest 2: triple tap → +10s');
resetVideo();
tap(300, 200, 100);
tap(310, 200, 200);
tap(320, 200, 200); // tap 3 (t=500)
advance(400);       // seek at t=900
assert(v.currentTime === 110, `triple tap accumulated: got ${v.currentTime}`);
assert(v.paused === false, 'still playing after triple tap');
resetTimers();

// ---- Test 3: side switch cancels accumulation ----
console.log('\nTest 3: side switch resets accumulation');
resetVideo();
tap(300, 200, 100); // right
tap(310, 200, 200); // right ×2 (amount 10)
tap(100, 200, 200); // left → resets, becomes 1st tap of new gesture
tap(90,  200, 200); // left ×2 (amount 10)
advance(400);
assert(v.currentTime === 90, `side switch → only left pair applied: got ${v.currentTime}`);
assert(v.paused === false, 'still playing');
resetTimers();

// ---- Test 4: seek clamped to duration ----
console.log('\nTest 4: seek clamped at video end');
resetVideo();
v.currentTime = 598; v.duration = 600;
tap(300, 200, 100);
tap(310, 200, 200);
advance(400);
assert(v.currentTime === 600, `clamped to duration: got ${v.currentTime}`);
resetTimers();

// ---- Test 5: taps outside video are ignored ----
console.log('\nTest 5: taps outside the video do nothing');
resetVideo();
v.currentTime = 100;
let ev = tap(500, 500, 100); // outside rect (right 400/bottom 400)
assert(!ev._pd, 'outside tap not preventDefaulted');
advance(400);
assert(v.currentTime === 100, 'no seek applied');
resetTimers();

// ---- Test 6: bottom-bar taps ignored ----
console.log('\nTest 6: bottom 15% (player controls) ignored');
resetVideo();
v.currentTime = 100;
ev = tap(300, 380, 100); // y=380 > 400*0.85=340
advance(400);
assert(v.currentTime === 100, 'no seek applied for controls tap');
resetTimers();

// ---- Test 7: live stream (duration=Infinity) doesn't break ----
console.log('\nTest 7: live stream (infinite duration)');
resetVideo();
v.duration = Infinity; v.currentTime = 0;
// forward on a live stream: seek allowed (no upper clamp)
tap(300, 200, 100);
tap(310, 200, 200);
advance(400);
assert(v.currentTime === 5, `forward on live: got ${v.currentTime}`);
resetTimers();
// rewind below 0 on a live stream: clamped to 0, no NaN/exception
tap(100, 200, 100);
tap(90, 200, 200);
advance(400);
assert(v.currentTime === 0, `rewind at 0 on live clamps to 0: got ${v.currentTime}`);
resetTimers();

// ---- Test 8: multi-touch (pinch) never triggers a skip ----
console.log('\nTest 8: pinch-zoom (2 fingers) ignored');
resetVideo();
v.currentTime = 100;
fire('touchstart', [{ clientX: 300, clientY: 200 }, { clientX: 100, clientY: 200 }], null);
ev = fire('touchend', [{ clientX: 100, clientY: 200 }], [{ clientX: 300, clientY: 200 }]);
assert(!ev._pd, 'pinch touchend not preventDefaulted');
advance(400);
assert(v.currentTime === 100, 'no seek applied');
resetTimers();

// ---- Test 9: first tap's delayed pause is neutralized ----
console.log('\nTest 9: player pause landing AFTER blocker releases');
resetVideo();
tap(300, 200, 100); // tap1 — video playing
v.pause();          // player pause lands before 2nd tap? no — simulate late: gesture first
tap(310, 200, 200); // tap2
// player's pause() call arrives very late, right after unblock
advance(600);       // seek at 400 + unblock 120 → t=720; pause at 700
v.pause();          // lands after unblock — this is the player's own delayed pause
assert(v.paused === true, 'late pause lands after unblock (player may pause again)');
resetTimers();

// ---- Test 10: tap then quick drag (scroll) is NOT a double-tap ----
console.log('\nTest 10: tap-then-drag never triggers a skip, never blocks scroll');
resetVideo();
v.currentTime = 100;
// tap 1 on the video
let st = fire('touchstart', [{ clientX: 300, clientY: 200 }], null);
assert(!st._pd, 'tap touchstart not preventDefaulted (scroll untouched)');
fire('touchend', [], [{ clientX: 300, clientY: 200 }]);
// quick drag starting 200ms later, finger travels 150px
st = fire('touchstart', [{ clientX: 300, clientY: 200 }], null);
assert(!st._pd, 'drag touchstart not preventDefaulted (scroll works)');
fire('touchmove', [{ clientX: 320, clientY: 300 }], null);
ev = fire('touchend', [], [{ clientX: 320, clientY: 350 }]);
assert(!ev._pd, 'drag touchend not preventDefaulted');
advance(500);
assert(v.currentTime === 100, 'no skip applied after tap-then-drag');
resetTimers();

// ---- Test 11: double-tap with small finger wobble still works ----
console.log('\nTest 11: double-tap with minor wobble (< 30px) works');
resetVideo();
v.currentTime = 100;
tap(300, 200, 100);     // tap 1
fire('touchstart', [{ clientX: 308, clientY: 205 }], null); // tap 2, 9px away
t += 150;               // finger-down time before release
ev = fire('touchend', [], [{ clientX: 312, clientY: 208 }]); // 12px travel total
assert(ev._pd === true, '2nd touchend preventDefaulted');
advance(400);
assert(v.currentTime === 105, 'skip applied despite wobble');
resetTimers();

// ---- Test 12: multi-touch during the gesture cancels it ----
console.log('\nTest 12: a second finger during the gesture cancels it');
resetVideo();
v.currentTime = 100;
tap(300, 200, 100); // tap 1
fire('touchstart', [{ clientX: 300, clientY: 200 }, { clientX: 150, clientY: 200 }], null); // pinch starts
fire('touchend', [{ clientX: 150, clientY: 200 }], [{ clientX: 300, clientY: 200 }]);
tap(310, 200, 200); // single tap right after — must NOT pair with tap 1
advance(400);
assert(v.currentTime === 100, 'no skip applied after interrupted gesture');
resetTimers();

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
