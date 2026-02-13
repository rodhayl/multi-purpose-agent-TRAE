# Sending Messages to TRAE Agent Chat

This document explains how prompt text is sent programmatically into the TRAE agent chat panel.

## Why This Exists

Prompt queue and automation workflows require reliable message delivery without manual typing.

Standard command-based chat APIs are not sufficient for this panel, so the extension uses CDP-backed browser interaction.

## Approach Summary

1. Discover active CDP connections to TRAE webviews
2. Ensure helper script injection in eligible chat contexts
3. Locate the active chat input (`contenteditable` strategy)
4. Insert text and dispatch submit interaction
5. Verify success/failure and retry with controlled backoff when needed

## Runtime Components

- `main_scripts/cdp-handler.js`
  - Connection management, `evaluate*` APIs, script injection lifecycle
- `extension.js` (Scheduler methods)
  - Queue orchestration and prompt send flow
- `main_scripts/debug-handler.js`
  - `evaluateInBrowser`, `getCDPConnections`, and related diagnostics

## Delivery Guarantees in Queue Mode

- Prompt sends are serialized through internal queueing
- Failed sends are retried with bounded attempts
- Queue advancement waits for silence timeout or task max-wait
- Manual controls (pause/resume/skip/stop) remain available throughout

## Troubleshooting

If sends fail:

- Verify CDP availability and active connection count
- Check injection helpers are present in target webview
- Confirm chat input selector still matches current UI structure
- Use live debug actions to inspect DOM and test selectors quickly

See:

- [LIVE_CDP_DEBUGGING.md](LIVE_CDP_DEBUGGING.md)
- [DEBUG_TESTING.md](DEBUG_TESTING.md)
