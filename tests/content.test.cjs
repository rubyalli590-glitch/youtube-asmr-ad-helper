const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");

function setup({ muted = false, ad = false } = {}) {
  let now = 0;
  let tick;
  let players;
  const events = {};
  class Element {
    constructor() {
      this.isConnected = true;
      this.parentElement = null;
      this.style = { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" };
    }
    getAttribute(name) { return this[name] ?? null; }
    getClientRects() { return this.visible === false ? [] : [{}]; }
    getBoundingClientRect() { return { left: 20, top: 40, width: 100, height: 40 }; }
  }
  function video(initial) {
    return { muted: initial, listeners: new Map(),
      addEventListener(name, cb) { this.listeners.set(name, cb); },
      removeEventListener(name) { this.listeners.delete(name); } };
  }
  const media = video(muted);
  const button = new Element();
  button.visible = false;
  button.requests = 0;
  button.onRequest = () => {};
  button.holdResponse = false;
  const messages = [];
  const callbacks = [];
  const player = new Element();
  player.ad = ad;
  player.skipPresent = ad;
  player.labelFallback = false;
  player.videos = [media];
  player.classList = { contains: (name) => name === "ad-showing" && player.ad };
  player.querySelectorAll = (selector) => {
    if (selector === "video") return player.videos;
    if (selector.startsWith(".video-ads")) return player.labelFallback ? [button] : [];
    return player.skipPresent && !player.labelFallback ? [button] : [];
  };
  button.parentElement = player;
  players = [player];
  const document = { querySelectorAll: () => players, addEventListener() {} };
  vm.runInNewContext(source, {
    document, Element, performance: { now: () => now },
    chrome: { runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        callbacks.push(callback);
        button.requests++;
        button.onRequest();
        if (!button.holdResponse) callback({ status: "input-sent" });
      }
    } },
    console: { warn() {} },
    getComputedStyle: (node) => node.style,
    MutationObserver: class { observe() {} disconnect() {} },
    window: { addEventListener: (name, cb) => { events[name] = cb; } },
    setInterval: (cb) => { tick = cb; return 1; }, clearInterval() {},
    queueMicrotask: (cb) => cb()
  });
  return { player, media, button, video, events, messages, callbacks,
    removePlayer() { players = []; },
    tick(ms = 200) { now += ms; tick(); } };
}

test("normal video stays audible and skip controls are not clicked", () => {
  const s = setup(); s.button.visible = true; s.tick();
  assert.equal(s.media.muted, false); assert.equal(s.button.requests, 0);
});
test("ad mutes, skips only when available, and restores only after ad completion", () => {
  const s = setup({ ad: true });
  assert.equal(s.media.muted, true); assert.equal(s.button.requests, 0);
  s.button.visible = true; s.button.disabled = true; s.tick();
  assert.equal(s.button.requests, 0);
  s.button.disabled = false; s.tick();
  assert.equal(s.button.requests, 1); assert.equal(s.media.muted, true);
  s.tick(); assert.equal(s.button.requests, 1);
  s.player.ad = false; s.button.visible = false;
  s.tick(100); assert.equal(s.media.muted, true);
  s.tick(300); assert.equal(s.media.muted, false);
  assert.equal(s.media.listeners.size, 0);
});
test("preexisting mute is preserved after unskippable ad", () => {
  const s = setup({ ad: true, muted: true });
  s.player.ad = false; s.tick(400);
  assert.equal(s.media.muted, true); assert.equal(s.button.requests, 0);
});
test("brief gap between consecutive ads does not unmute", () => {
  const s = setup({ ad: true }); s.player.ad = false; s.tick(100);
  s.player.ad = true; s.tick(100); assert.equal(s.media.muted, true);
  s.player.ad = false; s.tick(400); assert.equal(s.media.muted, false);
});
test("replacement video restores original state even if it inherited ad mute", () => {
  const s = setup({ ad: true }); const replacement = s.video(true);
  s.player.videos = [replacement]; s.tick();
  s.player.ad = false; s.tick(400);
  assert.equal(replacement.muted, false); assert.equal(s.media.muted, false);
});
test("hidden ancestors prevent clicking and failed clicks can retry", () => {
  const s = setup({ ad: true }); s.button.visible = true;
  s.player.style.opacity = "0"; s.tick(); assert.equal(s.button.requests, 0);
  s.player.style.opacity = "1"; s.tick(); assert.equal(s.button.requests, 1);
  s.tick(1000); assert.equal(s.button.requests, 2);
});
test("player removal and pagehide restore sound; pageshow resumes detection", () => {
  const s = setup({ ad: true }); s.removePlayer(); s.tick();
  assert.equal(s.media.muted, false);
  const b = setup({ ad: true }); b.events.pagehide();
  assert.equal(b.media.muted, false);
  b.events.pageshow(); assert.equal(b.media.muted, true);
});
test("site unmuting during an ad is corrected", () => {
  const s = setup({ ad: true }); s.media.muted = false;
  s.media.listeners.get("volumechange")(); assert.equal(s.media.muted, true);
});
test("a clickable child works under a pointer-events:none parent", () => {
  const s = setup({ ad: true });
  s.player.style.pointerEvents = "none"; s.button.visible = true; s.tick();
  assert.equal(s.button.requests, 1);
});
test("pointer-events:none on the button itself prevents clicking", () => {
  const s = setup({ ad: true });
  s.button.style.pointerEvents = "none"; s.button.visible = true; s.tick();
  assert.equal(s.button.requests, 0);
});
test("visible ad skip button works even without ad-showing class", () => {
  const s = setup(); s.player.skipPresent = true; s.button.visible = true; s.tick();
  assert.equal(s.button.requests, 1); assert.equal(s.media.muted, true);
  s.button.visible = false; s.tick(400); assert.equal(s.media.muted, false);
});
test("localized ad control label is a fallback when button classes change", () => {
  for (const label of ["Skip", "Skip ad", "Skip ads", "跳过广告", "略過廣告"]) {
    const s = setup({ ad: true }); s.player.labelFallback = true;
    s.button["aria-label"] = label; s.button.visible = true; s.tick();
    assert.equal(s.button.requests, 1, label);
  }
});
test("countdown and unrelated ad controls are not clicked by label fallback", () => {
  for (const label of ["Skip ad in 5 seconds", "5 秒后跳过广告", "了解详情", "Next video"]) {
    const s = setup({ ad: true }); s.player.labelFallback = true;
    s.button.textContent = label; s.button.visible = true; s.tick();
    assert.equal(s.button.requests, 0, label);
  }
});
test("debugger request never executes a DOM click and audio waits for completion", () => {
  const s = setup({ ad: true });
  s.button.click = () => { throw new Error("DOM click must not be used"); };
  s.button.dispatchEvent = () => { throw new Error("Synthetic events must not be used"); };
  s.button.visible = true; s.tick();
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].type, "YT_AD_HELPER_SKIP");
  assert.deepEqual(Object.keys(s.messages[0]), ["type"]);
  assert.equal(s.media.muted, true);
  s.player.ad = false; s.button.visible = false; s.tick(400);
  assert.equal(s.media.muted, false);
});
test("a pending debugger request prevents overlapping attempts and errors can retry", () => {
  const s = setup({ ad: true }); s.button.holdResponse = true;
  s.button.visible = true; s.tick(); s.tick(2000);
  assert.equal(s.messages.length, 1);
  s.callbacks[0]({ status: "error", error: "Debugger attach failed" });
  s.tick(1000); assert.equal(s.messages.length, 2);
});
