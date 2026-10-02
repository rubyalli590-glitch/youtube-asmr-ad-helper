"use strict";

const busyTabs = new Set();

function isYouTube(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "www.youtube.com" &&
      parsed.port === "";
  } catch {
    return false;
  }
}

// This function runs in the target page. Keep it self-contained; all code sent
// to Runtime.evaluate is extension-owned, never supplied in runtime messages.
function getSkipTarget(expectedHref) {
  if (location.origin !== "https://www.youtube.com" ||
      (expectedHref && location.href !== expectedHref)) return null;
  const selectors = ".ytp-skip-ad-button, .ytp-ad-skip-button-modern, " +
    ".ytp-ad-skip-button, .ytp-ad-skip-button-container button, " +
    ".ytp-ad-skip-button-container [role='button'], .ytp-skip-ad-button-container button";
  const adControls = ".video-ads button, .video-ads [role='button'], " +
    ".ytp-ad-module button, .ytp-ad-module [role='button']";
  const label = /^(?:skip(?:\s+ads?)?|跳过(?:广告)?|跳過(?:廣告)?|略過(?:廣告)?)\s*[›»]?$/i;
  for (const player of document.querySelectorAll(".html5-video-player")) {
    const candidates = new Set(player.querySelectorAll(selectors));
    for (const button of player.querySelectorAll(adControls)) {
      if ([button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent]
        .some(text => typeof text === "string" && label.test(text.trim()))) {
        candidates.add(button);
      }
    }
    for (const button of candidates) {
      if (!button.isConnected || button.disabled ||
          button.getAttribute("aria-disabled") === "true" ||
          button.getClientRects().length === 0 ||
          getComputedStyle(button).pointerEvents === "none") continue;
      let visible = true;
      for (let node = button; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.inert || style.display === "none" ||
            style.visibility === "hidden" || style.visibility === "collapse" ||
            Number(style.opacity) === 0) { visible = false; break; }
      }
      if (!visible) continue;
      // Visible known ad-only controls are evidence of an ad even when state
      // classes differ. Never seek media or click elsewhere to end an ad.
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0 ||
          x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      // An overlay, a moved player, or another control must not receive input.
      if (!hit || (hit !== button && !button.contains(hit))) continue;
      return { x, y, href: location.href };
    }
  }
  return null;
}

async function locate(target, expectedHref) {
  const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(${getSkipTarget.toString()})(${JSON.stringify(expectedHref || null)})`,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error("无法检查 Skip 按钮，请刷新 YouTube 页面。");
  const value = result.result?.value;
  if (!value || !isYouTube(value.href) || !Number.isFinite(value.x) ||
      !Number.isFinite(value.y) || value.x < 0 || value.y < 0) return null;
  return value;
}

async function skipAd(tabId) {
  if (busyTabs.has(tabId)) return { status: "busy" };
  busyTabs.add(tabId);
  const target = { tabId };
  let attached = false;
  let pressed = null;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    const first = await locate(target);
    if (!first) return { status: "not-ready" };
    // Recheck after attaching: layout or the SPA page may have changed.
    const current = await locate(target, first.href);
    if (!current) return { status: "not-ready" };
    const point = { x: current.x, y: current.y, button: "left", clickCount: 1 };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...point, type: "mousePressed", buttons: 1
    });
    pressed = point;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      ...point, type: "mouseReleased", buttons: 0
    });
    pressed = null;
    // Sending input is not proof of completion. Content script observes the
    // actual ad state and restores sound only after the ad has finished.
    return { status: "input-sent" };
  } catch (error) {
    return { status: "error", error: "请关闭此标签页的 F12 开发者工具，并确认扩展已获调试权限。" +
      " Chrome：" + error.message };
  } finally {
    if (attached) {
      // Best effort release after a failed mouseReleased command.
      if (pressed) {
        try {
          await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
            ...pressed, type: "mouseReleased", buttons: 0
          });
        } catch { /* Tab may already be closed or the debugger detached. */ }
      }
      try { await chrome.debugger.detach(target); }
      catch { /* Never detach another debugger if our attachment failed. */ }
    }
    busyTabs.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "YT_AD_HELPER_SKIP") return false;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      !Number.isInteger(sender.tab?.id) || !isYouTube(sender.url)) {
    sendResponse({ status: "rejected", error: "仅允许 YouTube 顶层页面请求跳过广告。" });
    return false;
  }
  skipAd(sender.tab.id).then(sendResponse);
  return true;
});
