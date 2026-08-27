// Test the injected main-world pause/play/load blocker by extracting the
// embedded code string from content.js and running it against a fake DOM.
'use strict';
const fs = require('fs');

const src = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');
const m = src.match(/var code = \[([\s\S]*?)\]\.join/);
if (!m) { console.error('FAIL: could not extract injected code'); process.exit(1); }
const codeArr = new Function('return [' + m[1] + ']')();
const injected = codeArr.join('\n');

// ---- fake page world ----
const winEvents = {};
const fakeWindow = {
  __tapskipInjected: undefined,
  addEventListener(type, fn) { winEvents[type] = fn; },
  dispatchEvent(e) { if (winEvents[e.type]) winEvents[e.type](); return true; },
};

class FakeMedia {
  constructor() { this._paused = false; this.log = []; }
  get paused() { return this._paused; }
  pause() { this.log.push('pause'); this._paused = true; }
  play() { this.log.push('play'); this._paused = false; }
  load() { this.log.push('load'); }
}

// run the injected code in the fake page world
new Function('window', 'HTMLMediaElement', injected)(fakeWindow, FakeMedia);

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  PASS:', msg);
  else { console.log('  FAIL:', msg); failures++; }
}

// ---- Test A: normal operation before blocking ----
console.log('\nBlocker Test A: normal operation');
const a = new FakeMedia();
a.pause(); a.play(); a.load();
assert(a.log.join(',') === 'pause,play,load', `methods work when not blocking (got ${a.log.join(',')})`);
assert(a.paused === false, 'play toggles paused state');

// ---- Test B: while blocking, pause/play/load are swallowed ----
console.log('\nBlocker Test B: blocking swallows pause/play/load');
fakeWindow.dispatchEvent({ type: '__tapskip_on' });
const b = new FakeMedia();
b.pause(); b.load(); b.play();
assert(b.log.length === 0, `all three swallowed while blocking (got ${b.log.join(',')})`);
assert(b.paused === false, 'paused state untouched while blocking');

// ---- Test C: __tapskip_play lets OUR play() through ----
console.log('\nBlocker Test C: escape-hatch play works while blocking');
fakeWindow.dispatchEvent({ type: '__tapskip_play' });
const c = new FakeMedia();
c.pause();                       // still swallowed
assert(c.log.length === 0, 'pause still swallowed');
c.play();
assert(c.log.join(',') === 'play', `play allowed via escape hatch (got ${c.log.join(',')})`);
assert(c.paused === false, 'play toggled state');

// ---- Test D: __tapskip_off re-enables everything and resets the hatch ----
console.log('\nBlocker Test D: off re-enables, hatch resets');
fakeWindow.dispatchEvent({ type: '__tapskip_off' });
const d = new FakeMedia();
d.pause(); d.play();
assert(d.log.join(',') === 'pause,play', 'pause+play work again after off');
// blocking re-engages for the next gesture — the hatch must NOT leak through
fakeWindow.dispatchEvent({ type: '__tapskip_on' });
const e = new FakeMedia();
e.play();
assert(e.log.length === 0, 'play blocked again after hatch reset (no leak across gestures)');

// ---- Test E: no double injection ----
console.log('\nBlocker Test E: idempotent injection');
const before = FakeMedia.prototype.pause;
new Function('window', 'HTMLMediaElement', injected)(fakeWindow, FakeMedia);
assert(FakeMedia.prototype.pause === before, 'injecting twice does not re-wrap prototypes');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL BLOCKER TESTS PASSED');
process.exit(failures ? 1 : 0);
