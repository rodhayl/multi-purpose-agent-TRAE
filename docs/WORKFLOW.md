# Multi Purpose Agent for TRAE Workflow

This document summarizes the current runtime workflow and key subsystems used by the extension.

## High-Level Architecture

- `extension.js`
  - Activation lifecycle, command registration, status bar, scheduler wiring
  - Orchestrates CDP handler, relauncher, debug handler, and settings panel
- `main_scripts/cdp-handler.js`
  - CDP discovery, session management, browser-side script injection, evaluation helpers
- `main_scripts/debug-handler.js`
  - Debug server and debug command routing for automation/test scripts
- `main_scripts/relauncher.js`
  - Relaunch flow to ensure TRAE starts with CDP flags/port alignment
- `settings-panel.js`
  - Webview UI for queue controls, scheduling, logs, stats, banned commands, and debug toggles

## Core Runtime Flow

1. Extension activates and initializes persistent state.
2. CDP + relaunch subsystems are constructed.
3. Scheduler starts and loads `auto-accept.schedule.*` configuration.
4. Status bar items and commands are registered.
5. If enabled state is persisted, environment checks run and polling starts.
6. Auto-accept loop handles actionable UI buttons and continue policies.

## Queue Workflow

Queue mode supports robust prompt orchestration:

- Builds runtime queue from `auto-accept.schedule.prompts`
- Optionally inserts check prompts between tasks
- Sends prompt text through CDP-backed chat injection
- Monitors activity and advances on silence timeout or per-item max-wait
- Supports `consume` and `loop` queue modes
- Supports manual controls: pause/resume/skip/stop

## Safety & Controls

- Banned command filtering prevents execution of dangerous shell patterns
- Queue start has source validation and activation grace protections
- Retry/backoff logic avoids prompt-send spamming during busy states
- Reset command restores extension runtime state to defaults

## Debug & Observability

- Local debug server for script-driven tests and diagnostics
- Debug commands expose queue status, conversation list, prompt history, logs, and system state
- Live CDP evaluate flow enables rapid browser-context debugging without rebuild cycles
- ROI statistics capture clicks, sessions, and estimated time saved

## Related Docs

- [DEBUG_TESTING.md](DEBUG_TESTING.md)
- [LIVE_CDP_DEBUGGING.md](LIVE_CDP_DEBUGGING.md)
- [SEND_MESSAGE_TRAE_TO_AGENT_CHAT.md](SEND_MESSAGE_TRAE_TO_AGENT_CHAT.md)
