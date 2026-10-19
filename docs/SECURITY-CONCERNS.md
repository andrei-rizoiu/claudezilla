# Security Concerns — Review Notes

Last reviewed: 2026-10-19 (v0.7.1).

## Keyboard-logger permission surface

**Finding:** Claudezilla cannot function as a keyboard logger as shipped, but the
permission architecture would not prevent a modified build from becoming one.

**Current code is clean:**

- The only keyboard handling is `pressKey()` (`extension/content.js:1731`),
  which synthesizes and dispatches `keydown`/`keypress`/`keyup` events to simulate
  typing. It never registers listeners to capture real keystrokes.
- Zero `addEventListener('keydown'|'keypress'|'keyup')` calls exist anywhere in
  `extension/`. The only keydown listeners in the repo are website hotkeys
  (`docs/repo-commands.html:586`, `website/scripts/notify.js:129`) — not shipped in the extension.

**Existing anti-exfiltration posture (keep these):**

- `background.js:327,347` — `webRequest` deliberately does NOT record `requestBody`
  ("may contain passwords, tokens, credit cards"); metadata only.
- `redactSensitiveUrl()` (`background.js:269`) — strips sensitive query params from logs.
- Console capture is opt-in only (`content.js:606-618`).
- Manifest declares `"data_collection_permissions": {"required": ["none"]}` (`manifest.json:11-15`).

**The gap:**

- `<all_urls>` content-script injection (`manifest.json:22,35`) means any future or
  malicious build could add a single `document.addEventListener('keydown', ...)` in
  `content.js` and capture every keystroke on every page, then exfiltrate via the
  existing native-messaging or network channels.

**Controls / review checklist:**

1. Treat any diff adding keyboard *listeners* (vs. dispatchers) to `content.js` as
   a red flag during review.
2. Keep the no-`requestBody`, URL-redaction, and opt-in-console patterns intact.
3. If distributing via AMO, signed builds pin the reviewed code; local dev builds
   (`web-ext run`) are unreviewed — don't install unknown local builds.
