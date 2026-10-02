# YouTube ASMR Ad Helper

Helps you enjoy ASMR without being disturbed by ads.

A lightweight Chrome / Edge extension that mutes YouTube ads, automatically clicks the official Skip button when available, and restores your previous mute state after the ad break.

## Features

- Automatically mute the YouTube player during ads.
- Press the visible, enabled Skip button using browser-level mouse input.
- Keep unskippable ads muted until they finish.
- Preserve your original mute state and volume level.
- Handle consecutive ads, player replacement, and navigation between videos.

The extension does not accelerate ads or seek through them. It only attempts to skip when an official Skip control is available.

## Install

1. Download this repository using **Code → Download ZIP** and extract it.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
5. Accept the requested debugging permission and refresh any open YouTube pages.
6. Close DevTools on the YouTube tab before testing automatic skipping.

To update, replace the extension files, click **Reload** on the extension management page, and refresh YouTube. Version: **1.1.0**.

## How it works

The content script observes the player and saves the previous mute state when an ad starts. When a Skip button is available, it asks the background worker to send browser-level mouse input through `chrome.debugger` and `Input.dispatchMouseEvent`.

The worker accepts requests only from this extension's top-level YouTube content script. It independently checks the current page, locates an eligible Skip button, verifies visibility and hit testing, and checks again before sending input. It disconnects after the attempt. Caller-provided coordinates, scripts, and arbitrary debugging commands are not accepted.

Sending input is not considered proof that an ad ended. Audio is restored after the player leaves its detected ad state, with a short grace period for consecutive ads. A player that was already muted remains muted.

## Privacy and permission

- No analytics, tracking, data uploads, or external service requests are implemented.
- No browsing history, credentials, or personal data are stored by this extension.
- The content script runs only on `https://www.youtube.com/*`.
- The extension requests the **debugger permission**, a broad browser permission. This code uses it only to inspect the relevant YouTube page and send input to its Skip button.
- Chrome may briefly display a debugging banner during an attempt.

The permission itself is broader than the extension's intended behavior. Review `background.js` and `content.js` to inspect its use.

## Troubleshooting and limitations

- Keep DevTools closed on the YouTube tab; another debugging session may conflict.
- If Chrome disables the extension after a permission change, re-enable it and accept the permission. If necessary, remove and load the unpacked extension again.
- YouTube may change its markup or behavior. Skipping is not guaranteed across all ads, accounts, or browser versions.
- Detection has a small reaction delay; the beginning of an ad may still be audible.
- Muting affects the player's media, not the entire browser tab.
- Disabling the extension during an ad may leave it muted until you refresh or unmute manually.
- Automatic skipping has been confirmed in one user Chrome session. Automated tests use simulated APIs and DOM elements, not live YouTube ads.

## Tests

With a recent Node.js version, run from the repository folder:

```sh
node --test tests/content.test.cjs tests/background.test.cjs
```

Tests cover mute restoration, button eligibility, request validation, page changes, overlays, input order, concurrent requests, and debugging cleanup.

## References

- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [DOM event trust](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted)
