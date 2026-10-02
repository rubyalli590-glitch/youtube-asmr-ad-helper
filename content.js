(() => {
  "use strict";

  const SKIP_SELECTORS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-container button",
    ".ytp-ad-skip-button-container [role='button']",
    ".ytp-skip-ad-button-container button"
  ].join(",");
  const AD_CONTROLS = ".video-ads button, .video-ads [role='button'], " +
    ".ytp-ad-module button, .ytp-ad-module [role='button']";
  const SKIP_LABEL = /^(?:skip(?:\s+ads?)?|跳过(?:广告)?|跳過(?:廣告)?|略過(?:廣告)?)\s*[›»]?$/i;
  const POLL_MS = 200;
  const END_GRACE_MS = 300;
  const CLICK_RETRY_MS = 1000;
  const sessions = new Map();
  let interval = null;
  let queued = false;
  let running = false;

  function clickable(button) {
    if (!button.isConnected || button.disabled ||
        button.getAttribute("aria-disabled") === "true" ||
        button.getClientRects().length === 0 ||
        getComputedStyle(button).pointerEvents === "none") return false;
    for (let node = button; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === "none" ||
          style.visibility === "hidden" || style.visibility === "collapse" ||
          Number(style.opacity) === 0) return false;
    }
    return true;
  }

  function findSkipButton(player) {
    const known = Array.from(player.querySelectorAll(SKIP_SELECTORS)).find(clickable);
    if (known) return known;
    // Fallback stays inside ad UI, never matches navigation or "Next video".
    return Array.from(player.querySelectorAll(AD_CONTROLS)).find(button => {
      const labels = [button.getAttribute("aria-label"), button.getAttribute("title"),
        button.textContent];
      return labels.some(label => typeof label === "string" &&
        SKIP_LABEL.test(label.trim())) && clickable(button);
    });
  }

  function activateSkipButton(session) {
    session.pending = true;
    const report = error => {
      session.pending = false;
      if (error && error !== session.lastError) {
        console.warn("[YouTube 广告助手 1.1.0] 自动跳过失败：", error);
      }
      session.lastError = error || null;
    };
    try {
      // Never pass caller-supplied click coordinates or CDP commands.
      // The worker independently checks the page and finds the current button.
      chrome.runtime.sendMessage({ type: "YT_AD_HELPER_SKIP" }, response => {
        const error = chrome.runtime.lastError;
        report(error ? error.message : response?.error);
      });
    } catch (error) {
      report(error.message);
    }
  }

  function restore(session) {
    for (const [video, original] of session.videos) {
      video.removeEventListener("volumechange", original.onVolumeChange);
      video.muted = original.muted;
    }
    session.videos.clear();
  }

  function silence(session, video) {
    if (!session.videos.has(video)) {
      // Replacement video elements may inherit the mute applied to the old one.
      // Keep the state from the start of this ad break across replacements.
      if (session.originalMuted === undefined) session.originalMuted = video.muted;
      const onVolumeChange = () => {
        if (session.videos.has(video) && !video.muted) video.muted = true;
      };
      session.videos.set(video, { muted: session.originalMuted, onVolumeChange });
      video.addEventListener("volumechange", onVolumeChange);
    }
    if (!video.muted) video.muted = true;
  }

  function scan() {
    if (!running) return;
    const now = performance.now();
    const players = new Set(document.querySelectorAll(".html5-video-player"));

    for (const [player, session] of sessions) {
      if (!players.has(player) || !player.isConnected) {
        restore(session);
        sessions.delete(player);
      }
    }

    for (const player of players) {
      let session = sessions.get(player);
      // Do not use ad-interrupting alone: it can remain during normal playback.
      const button = findSkipButton(player);
      // A usable ad-only skip control is also evidence of an ad, even when
      // YouTube's player state classes differ between page variants.
      const inAd = player.classList.contains("ad-showing") || Boolean(button);
      if (inAd) {
        if (!session) {
          session = { videos: new Map(), originalMuted: undefined,
            lastAdAt: now, lastClickAt: -Infinity, lastButton: null,
            pending: false, lastError: null };
          sessions.set(player, session);
        }
        session.lastAdAt = now;
        for (const video of player.querySelectorAll("video")) silence(session, video);
        // Only click known skip controls inside the player, after they are usable.
        if (button && !session.pending && (button !== session.lastButton ||
            now - session.lastClickAt >= CLICK_RETRY_MS)) {
          session.lastButton = button;
          session.lastClickAt = now;
          activateSkipButton(session);
        }
      } else if (session && now - session.lastAdAt >= END_GRACE_MS) {
        // Wait for actual ad completion, including consecutive ads, before unmuting.
        restore(session);
        sessions.delete(player);
      }
    }
  }

  function scheduleScan() {
    if (!running || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      scan();
    });
  }

  const observer = new MutationObserver(scheduleScan);
  function start() {
    if (running) return;
    running = true;
    observer.observe(document, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "disabled", "aria-disabled"] });
    interval = setInterval(scan, POLL_MS);
    scan();
  }
  function stop() {
    running = false;
    observer.disconnect();
    clearInterval(interval);
    interval = null;
    for (const session of sessions.values()) restore(session);
    sessions.clear();
  }
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", start);
  document.addEventListener("yt-navigate-finish", scheduleScan);
  start();
})();
