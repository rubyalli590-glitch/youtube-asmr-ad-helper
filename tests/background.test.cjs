const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");

function setup() {
  const calls = [];
  let listener;
  const s = { calls, attachError: null, failType: null, holdAttach: false, blocked: false,
    evaluations: 0, onEvaluate() {}, href: "https://www.youtube.com/watch?v=test" };
  class Element {
    constructor() {
      this.isConnected = true;
      this.parentElement = null;
      this.style = { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" };
    }
    getAttribute(name) { return this[name] ?? null; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    getBoundingClientRect() { return { left: 20, top: 40, width: 100, height: 40 }; }
    contains(hit) { return hit === this; }
  }
  const button = new Element();
  const player = new Element();
  button.parentElement = player;
  player.querySelectorAll = selector => selector.startsWith(".video-ads") ? [] : [button];
  const page = vm.createContext({
    Element, innerWidth: 1280, innerHeight: 720,
    location: { origin: "https://www.youtube.com", href: s.href },
    getComputedStyle: node => node.style,
    document: {
      querySelectorAll: () => [player],
      elementFromPoint: () => s.blocked ? new Element() : button
    }
  });
  const chrome = {
    runtime: { id: "our-extension", onMessage: { addListener(cb) { listener = cb; } } },
    debugger: {
      async attach(target, version) {
        calls.push({ method: "attach", tabId: target.tabId, version });
        if (s.attachError) throw new Error(s.attachError);
        if (s.holdAttach) await new Promise(resolve => { s.resumeAttach = resolve; });
      },
      async sendCommand(target, method, params) {
        calls.push({ method, tabId: target.tabId, params });
        if (params.type === s.failType) throw new Error("input failure");
        if (method === "Runtime.evaluate") {
          s.evaluations++;
          s.onEvaluate(s.evaluations);
          return { result: { value: vm.runInContext(params.expression, page) } };
        }
        return {};
      },
      async detach(target) { calls.push({ method: "detach", tabId: target.tabId }); }
    }
  };
  vm.runInNewContext(source, { chrome, URL });
  s.button = button;
  s.page = page;
  s.sender = { id: "our-extension", frameId: 0, tab: { id: 42 }, url: s.href };
  s.send = (sender = s.sender, message = { type: "YT_AD_HELPER_SKIP" }) =>
    new Promise(resolve => {
      const keepOpen = listener(message, sender, resolve);
      if (!keepOpen) resolve(undefined);
    });
  s.input = () => calls.filter(call => call.method === "Input.dispatchMouseEvent");
  return s;
}

test("sends browser input to revalidated button center and always detaches", async () => {
  const s = setup();
  const response = await s.send();
  assert.equal(response.status, "input-sent");
  assert.deepEqual(s.calls.map(call => call.method), ["attach", "Runtime.evaluate",
    "Runtime.evaluate", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "detach"]);
  assert.equal(s.calls.every(call => call.tabId === 42), true);
  assert.deepEqual(s.input().map(call => call.params.type), ["mousePressed", "mouseReleased"]);
  assert.equal(s.input()[0].params.x, 70);
  assert.equal(s.input()[0].params.y, 60);
  assert.equal(s.input()[0].params.buttons, 1);
  assert.equal(s.input()[1].params.buttons, 0);
});
test("rejects foreign senders, other origins, invalid tabs, and subframes without attaching", async () => {
  const s = setup();
  const bad = [
    { ...s.sender, id: "another-extension" },
    { ...s.sender, url: "https://example.com/" },
    { ...s.sender, url: "https://www.youtube.com.evil.example/" },
    { ...s.sender, url: "http://www.youtube.com/" },
    { ...s.sender, frameId: 1 },
    { ...s.sender, tab: { id: "42" } }
  ];
  for (const sender of bad) assert.equal((await s.send(sender)).status, "rejected");
  assert.equal(s.calls.length, 0);
});
test("ignores caller-supplied coordinates and commands", async () => {
  const s = setup();
  await s.send(s.sender, { type: "YT_AD_HELPER_SKIP", x: 999, y: 999,
    expression: "location='https://example.com'", command: "Page.navigate" });
  assert.equal(s.input()[0].params.x, 70);
  assert.equal(s.calls.some(call => call.method === "Page.navigate"), false);
});
test("does not click a hidden, disabled, covered, or offscreen button", async () => {
  for (const scenario of ["hidden", "disabled", "covered", "offscreen", "inert"]) {
    const s = setup();
    if (scenario === "hidden") s.button.hidden = true;
    if (scenario === "disabled") s.button.disabled = true;
    if (scenario === "covered") s.blocked = true;
    if (scenario === "inert") s.button.inert = true;
    if (scenario === "offscreen") s.button.getBoundingClientRect = () =>
      ({ left: -500, top: 0, width: 100, height: 40 });
    assert.equal((await s.send()).status, "not-ready", scenario);
    assert.equal(s.input().length, 0, scenario);
    assert.equal(s.calls.at(-1).method, "detach", scenario);
  }
});
test("refuses input after navigating to another site or video", async () => {
  const otherSite = setup();
  otherSite.page.location.origin = "https://example.com";
  otherSite.page.location.href = "https://example.com/";
  assert.equal((await otherSite.send()).status, "not-ready");
  assert.equal(otherSite.input().length, 0);
  const videoChange = setup();
  videoChange.onEvaluate = count => {
    if (count === 2) videoChange.page.location.href = "https://www.youtube.com/watch?v=other";
  };
  assert.equal((await videoChange.send()).status, "not-ready");
  assert.equal(videoChange.input().length, 0);
});
test("rechecks button visibility immediately before sending input", async () => {
  const s = setup();
  s.onEvaluate = count => { if (count === 2) s.button.hidden = true; };
  assert.equal((await s.send()).status, "not-ready");
  assert.equal(s.input().length, 0);
});
test("attach failure reports error and never detaches someone else's debugger", async () => {
  const s = setup(); s.attachError = "Another debugger is already attached";
  const response = await s.send();
  assert.equal(response.status, "error");
  assert.match(response.error, /F12/);
  assert.deepEqual(s.calls.map(call => call.method), ["attach"]);
  s.attachError = null;
  assert.equal((await s.send()).status, "input-sent");
});
test("failed release attempts cleanup release before detaching", async () => {
  const s = setup(); s.failType = "mouseReleased";
  assert.equal((await s.send()).status, "error");
  assert.deepEqual(s.input().map(call => call.params.type),
    ["mousePressed", "mouseReleased", "mouseReleased"]);
  assert.equal(s.calls.at(-1).method, "detach");
});
test("only one click operation can be in flight for the same tab", async () => {
  const s = setup(); s.holdAttach = true;
  const first = s.send();
  assert.equal((await s.send()).status, "busy");
  assert.equal(s.calls.filter(call => call.method === "attach").length, 1);
  s.resumeAttach(); await first;
  assert.equal(s.input().length, 2);
});
