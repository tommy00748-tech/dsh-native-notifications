# Changelog

## 1.0.0

First public release.

- Native desktop notifications for DeepSeek Harness, attributed to the DSH app
  (macOS banners, Windows toasts, Linux notifications through the platform's
  notification API). Clicking a banner focuses DSH and opens the conversation.
- Host half watches the events that need a human — approval requests, user
  questions, sign-in prompts — plus turn completion and agent errors, and serves
  two authenticated same-origin routes (`/native-notifications/events` long poll
  and `/native-notifications/report` diagnostics).
- Client half long-polls those routes and shows each banner; a page reload never
  replays old banners (cursor + Host epoch in `localStorage`).
- Noise guards: approvals that an automatic reviewer settles never ring, a
  failure suppresses that turn's completion banner, goal rounds re-entering
  `running` cancel the pending completion banner, duplicate banners are dropped.
- Synthesised chime (no audio asset, no OS default sound, no double ring) with
  `cute` / `bell` / `bright` / `custom` / `muted` presets and a
  **Settings → General → Notification sound** row with preview and a custom
  note-sequence input.
- One optional row config (profile patch) for per-event switches, delays, idle
  grace, root-session filtering, markdown stripping and the audit log.
- Audit log at `~/.dsh/dsh-native-notifications.log` records every banner, the
  active preset and the client's permission state.
